'use strict';

const crypto = require('node:crypto');
const { normalizeSearchText } = require('./document-service.cjs');
const recordService = require('../database/record-service.cjs');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS field_discovery_runs (
    id TEXT PRIMARY KEY,
    trigger_document_id TEXT NOT NULL REFERENCES document_records(id) ON DELETE CASCADE,
    trigger_sha256 TEXT NOT NULL,
    registry_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
    field_count INTEGER NOT NULL DEFAULT 0,
    searched_count INTEGER NOT NULL DEFAULT 0,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    no_evidence_count INTEGER NOT NULL DEFAULT 0,
    ragflow_queries INTEGER NOT NULL DEFAULT 0,
    error_text TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS field_discovery_runs_document_idx ON field_discovery_runs(trigger_document_id, started_at DESC);
  CREATE TABLE IF NOT EXISTS document_field_candidates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES field_discovery_runs(id) ON DELETE CASCADE,
    field_definition_id INTEGER REFERENCES data_field_definitions(id),
    field_code TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    field_key TEXT NOT NULL,
    field_label_ar TEXT NOT NULL,
    data_type TEXT NOT NULL,
    unit TEXT,
    field_class TEXT,
    source_document_id TEXT REFERENCES document_records(id) ON DELETE SET NULL,
    source_element_id TEXT REFERENCES document_elements(id) ON DELETE SET NULL,
    source_file_name TEXT,
    source_sha256 TEXT,
    page_number INTEGER,
    source_location_json TEXT NOT NULL DEFAULT '{}',
    search_terms_json TEXT NOT NULL DEFAULT '[]',
    retrieval_method TEXT NOT NULL,
    retrieval_reference_json TEXT NOT NULL DEFAULT '{}',
    evidence_text TEXT NOT NULL DEFAULT '',
    raw_value TEXT,
    suggested_value TEXT,
    confidence REAL,
    validation_status TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','reviewed','rejected','no_evidence')),
    reviewed_value_json TEXT,
    review_note TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, field_code, source_element_id)
  );
  CREATE INDEX IF NOT EXISTS document_field_candidates_review_idx ON document_field_candidates(review_status, created_at DESC);
  CREATE INDEX IF NOT EXISTS document_field_candidates_run_idx ON document_field_candidates(run_id, field_code);
  CREATE TABLE IF NOT EXISTS document_candidate_promotions (
    candidate_id TEXT PRIMARY KEY REFERENCES document_field_candidates(id),
    form_record_id INTEGER NOT NULL REFERENCES form_records(form_record_id),
    form_field_id INTEGER NOT NULL REFERENCES form_fields(form_field_id),
    source_id INTEGER NOT NULL REFERENCES data_sources(source_id),
    promoted_by TEXT,
    promoted_at TEXT NOT NULL,
    UNIQUE(form_record_id,form_field_id)
  );
  CREATE INDEX IF NOT EXISTS document_candidate_promotions_record_idx ON document_candidate_promotions(form_record_id,form_field_id);
`;

const MAX_LOCAL_EVIDENCE_PER_FIELD = 8;
const MAX_RAG_EVIDENCE_PER_FIELD = 3;
const MAX_FIELD_ALIASES = 32;
const MAX_QUERY_CONCURRENCY = 3;
const RAGFLOW_FIELD_BATCH_LIMIT = 40;

function migrate(database) {
  database.exec(SCHEMA);
  const columns = database.prepare('PRAGMA table_info(document_field_candidates)').all().map(column => column.name);
  if (!columns.includes('suggested_value')) database.exec('ALTER TABLE document_field_candidates ADD COLUMN suggested_value TEXT');
  if (!columns.includes('confidence')) database.exec('ALTER TABLE document_field_candidates ADD COLUMN confidence REAL');
}

function normalizeDataType(value) {
  const type = String(value ?? '').trim().toLowerCase();
  if (['string','str','varchar','textual'].includes(type)) return 'text';
  if (['number','numeric','float','double','real'].includes(type)) return 'decimal';
  if (['int','long'].includes(type)) return 'integer';
  if (['bool'].includes(type)) return 'boolean';
  return type;
}

function compatibleDataTypes(left, right) {
  const leftType = normalizeDataType(left);
  const rightType = normalizeDataType(right);
  return leftType === rightType || ['integer','decimal'].includes(leftType) && ['integer','decimal'].includes(rightType);
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function aliasesFor(database, field) {
  const aliases = new Set([field.label_ar, field.field_key, field.field_code].map(normalizeSearchText).filter((value) => value.length >= 2));
  if (field.field_definition_id) {
    const canonicalAliases = database.prepare(`SELECT alias FROM data_field_aliases
      WHERE field_definition_id=? AND approved=1 ORDER BY confidence DESC, id`).all(field.field_definition_id);
    for (const item of canonicalAliases) {
      const alias = normalizeSearchText(item.alias);
      if (alias.length >= 2) aliases.add(alias);
    }
  }
  const formAliases = database.prepare(`SELECT DISTINCT alias.alias_text FROM form_field_aliases alias
    JOIN form_fields form_field ON form_field.form_field_id=alias.form_field_id
    JOIN form_versions version ON version.form_version_id=form_field.form_version_id
    WHERE form_field.field_code=? AND version.status='published' AND alias.is_approved=1`).all(field.field_code);
  for (const item of formAliases) {
    const alias = normalizeSearchText(item.alias_text);
    if (alias.length >= 2) aliases.add(alias);
  }
  return [...aliases].slice(0, MAX_FIELD_ALIASES);
}

function fieldRegistry(database) {
  const definitions = database.prepare(`SELECT id AS field_definition_id,entity_type,field_key,
    entity_type || '.' || field_key AS field_code,label_ar,data_type,unit,field_class,description
    FROM data_field_definitions WHERE active=1 AND entity_type NOT IN ('system','metadata') ORDER BY entity_type,field_key`).all();
  const definitionsByCode = new Map(definitions.map(field => [field.field_code,field]));
  const registry = new Map();
  const formFields = database.prepare(`SELECT NULL AS field_definition_id,
    CASE WHEN form.form_code='legacy_directorate_v1' THEN 'directorate' ELSE form.form_code END AS entity_type,
    form_field.field_code,form_field.field_code AS field_key,form_field.label_ar,
    COALESCE(form_field.data_type_override,definition.data_type,'text') AS data_type,
    unit.name_ar AS unit,form_field.storage_class AS field_class,definition.description
    FROM form_fields form_field
    JOIN form_versions version ON version.form_version_id=form_field.form_version_id AND version.status='published'
    JOIN form_definitions form ON form.form_id=version.form_id
    LEFT JOIN field_definitions definition ON definition.field_definition_id=form_field.field_definition_id
    LEFT JOIN measurement_units unit ON unit.unit_id=form_field.unit_id
    WHERE form_field.is_importable=1 AND form_field.is_derived=0 AND form_field.storage_class<>'ignored_derived'
      AND version.version_number=(SELECT MAX(latest.version_number) FROM form_versions latest
        WHERE latest.form_id=version.form_id AND latest.status='published')
    ORDER BY form.form_code,form_field.sort_order,form_field.field_code`).all();
  for (const field of formFields) {
    const existing = registry.get(field.field_code);
    if (existing) {
      existing.form_field = true;
      existing.form_label_ar = field.label_ar;
      continue;
    }
    registry.set(field.field_code, { ...(definitionsByCode.get(field.field_code) ?? {}), ...field,
      field_definition_id: definitionsByCode.get(field.field_code)?.field_definition_id ?? null,
      label_ar: definitionsByCode.get(field.field_code)?.label_ar ?? field.label_ar,
      unit: definitionsByCode.get(field.field_code)?.unit ?? field.unit,
      field_class: definitionsByCode.get(field.field_code)?.field_class ?? field.field_class,
      field_key: definitionsByCode.get(field.field_code)?.field_key ?? field.field_code, aliases: [], form_field: true });
  }
  for (const field of registry.values()) field.aliases = aliasesFor(database, field);
  return [...registry.values()].filter((field) => field.field_class !== 'review_decision' && field.field_class !== 'ignored_derived');
}

function buildLocalCandidates(database, field, aliases, triggerDocumentId, runId, now) {
  const conditions = aliases.map(() => 'instr(element.search_text,?)>0').join(' OR ');
  if (!conditions) return [];
  const rows = database.prepare(`SELECT element.id AS element_id,element.document_id,document.file_name,document.sha256,
    element.element_type,element.heading,element.content,element.page_number,element.position_json,element.confidence,element.source_json
    FROM document_elements element JOIN document_records document ON document.id=element.document_id
    WHERE (${conditions}) ORDER BY CASE WHEN element.document_id=? THEN 0 ELSE 1 END,document.created_at DESC,element.sequence_number
    LIMIT ?`).all(...aliases, triggerDocumentId, MAX_LOCAL_EVIDENCE_PER_FIELD);
  return rows.map((row) => {
    const evidence = evidenceLine(row, aliases);
    const rawValue = extractLabelValue(evidence, aliases);
    const sourceConfidence = row.confidence == null ? null : Number(row.confidence);
    const confidence = Math.max(0, Math.min(1, (rawValue ? 0.96 : 0.4) * (Number.isFinite(sourceConfidence) ? 0.75 + sourceConfidence * 0.25 : 1)));
    return {
      id: crypto.randomUUID(), runId, field, sourceDocumentId: row.document_id, sourceElementId: row.element_id,
      sourceFileName: row.file_name, sourceSha256: row.sha256, pageNumber: row.page_number,
      sourceLocation: { pageNumber: row.page_number, position: parseJson(row.position_json, null), source: parseJson(row.source_json, {}) },
      searchTerms: aliases, retrievalMethod: 'local-literal', retrievalReference: { elementType: row.element_type, heading: row.heading },
      evidenceText: evidence.slice(0, 4000), rawValue, suggestedValue: normalizeCandidateValue(field, rawValue), confidence,
      validationStatus: rawValue ? 'needs-type-and-context-review' : 'evidence-only', createdAt: now,
    };
  });
}

function normalizeCandidateValue(field, value) {
  if (value == null || !['integer','decimal'].includes(normalizeDataType(field.data_type))) return value ?? null;
  const original = String(value).trim();
  const normalizedDigits = original.replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0));
  if (!/^[+-]?[\d\s٬,٫.]+$/.test(normalizedDigits)) return original;
  return normalizedDigits.replace(/[\s٬,]/g, '').replace(/٫/g, '.');
}

function evidenceLine(row, aliases) {
  const lines = String(row.content ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const normalizedAliases = [...aliases].sort((left, right) => right.length - left.length);
  const exactLine = lines.find((line) => {
    const normalized = normalizeSearchText(line);
    return normalizedAliases.some((alias) => normalized.includes(alias));
  });
  return exactLine ?? String(row.content ?? '').slice(0, 4000);
}

function extractLabelValue(line, aliases) {
  const parts = String(line ?? '').split(/[:：=]/);
  if (parts.length < 2) return null;
  const label = normalizeSearchText(parts.shift());
  if (!aliases.some((alias) => label === alias)) return null;
  const value = parts.join(':').trim().slice(0, 500);
  return value || null;
}

function makeRagQuestion(field) {
  const terms = [...new Set([field.label_ar, ...field.aliases].filter(Boolean))].slice(0, 8);
  return `استرجع أدلة الوثائق المتعلقة بالحقل «${field.label_ar}» وصِيَغه البديلة: ${terms.join('، ')}`.slice(0, 500);
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function buildRagCandidates(database, field, runId, now, retrieve) {
  const result = await retrieve({ question: makeRagQuestion(field), limit: MAX_RAG_EVIDENCE_PER_FIELD });
  const rows = Array.isArray(result?.rows) ? result.rows.slice(0, MAX_RAG_EVIDENCE_PER_FIELD) : [];
  return rows.filter((row) => typeof row.content === 'string' && row.content.trim()).map((row) => {
    const referenced = row.datasetId && row.documentId
      ? database.prepare(`SELECT document.id,document.file_name,document.sha256 FROM document_ragflow_references reference
        JOIN document_records document ON document.id=reference.document_id
        WHERE reference.dataset_id=? AND reference.ragflow_document_id=?`).get(row.datasetId,row.documentId)
      : null;
    const sourceHash = /^[a-f0-9]{64}$/i.test(String(row.metadata?.source_sha256 ?? '')) ? String(row.metadata.source_sha256) : null;
    const source = referenced ?? (sourceHash
      ? database.prepare('SELECT id,file_name,sha256 FROM document_records WHERE sha256=?').get(sourceHash)
      : null);
    return source ? {
      id: crypto.randomUUID(), runId, field, sourceDocumentId: source.id, sourceElementId: null,
      sourceFileName: String(source.file_name).slice(0, 240),
      sourceSha256: source.sha256, pageNumber: null,
      sourceLocation: { positions: Array.isArray(row.positions) ? row.positions : [], datasetId: row.datasetId ?? null },
      searchTerms: field.aliases, retrievalMethod: 'ragflow-hybrid',
      retrievalReference: { documentId: row.documentId ?? null, datasetId: row.datasetId ?? null, similarity: row.similarity ?? null },
      evidenceText: String(row.content).slice(0, 4000), rawValue: null,
      validationStatus: 'semantic-evidence-needs-human-extraction', createdAt: now,
    } : null;
  }).filter(Boolean);
}

function insertCandidate(database, candidate) {
  database.prepare(`INSERT OR IGNORE INTO document_field_candidates
    (id,run_id,field_definition_id,field_code,entity_type,field_key,field_label_ar,data_type,unit,field_class,
      source_document_id,source_element_id,source_file_name,source_sha256,page_number,source_location_json,
      search_terms_json,retrieval_method,retrieval_reference_json,evidence_text,raw_value,suggested_value,confidence,validation_status,review_status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(candidate.id,candidate.runId,candidate.field.field_definition_id ?? null,
      candidate.field.field_code,candidate.field.entity_type,candidate.field.field_key,candidate.field.label_ar,candidate.field.data_type,
      candidate.field.unit ?? null,candidate.field.field_class ?? null,candidate.sourceDocumentId,candidate.sourceElementId,
      candidate.sourceFileName,candidate.sourceSha256,candidate.pageNumber,JSON.stringify(candidate.sourceLocation),
      JSON.stringify(candidate.searchTerms),candidate.retrievalMethod,JSON.stringify(candidate.retrievalReference),candidate.evidenceText,
      candidate.rawValue,candidate.suggestedValue ?? candidate.rawValue,candidate.confidence ?? null,candidate.validationStatus,
      ['not-searched-remotely','ragflow-unavailable','ragflow-no-hit'].includes(candidate.retrievalMethod) ? 'no_evidence' : 'pending',
      candidate.createdAt,candidate.createdAt);
}

function noEvidenceCandidate(runId, field, retrievalMethod, validationStatus, now) {
  return {
    id: crypto.randomUUID(), runId, field, sourceDocumentId: null, sourceElementId: null,
    sourceFileName: null, sourceSha256: null, pageNumber: null, sourceLocation: {}, searchTerms: field.aliases,
    retrievalMethod, retrievalReference: {}, evidenceText: '', rawValue: null, validationStatus, createdAt: now,
  };
}

async function discoverFields(database, request = {}, options = {}) {
  const triggerDocumentId = String(request.documentId ?? '');
  const trigger = database.prepare('SELECT id,sha256 FROM document_records WHERE id=?').get(triggerDocumentId);
  if (!trigger) throw new Error('الوثيقة غير موجودة لبدء اكتشاف الحقول.');
  const fields = fieldRegistry(database);
  const registryFingerprint = crypto.createHash('sha256').update(JSON.stringify(fields.map((field) => ({
    code: field.field_code, label: field.label_ar, type: field.data_type, aliases: field.aliases,
  })))).digest('hex');
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  database.prepare(`INSERT INTO field_discovery_runs(id,trigger_document_id,trigger_sha256,registry_fingerprint,status,field_count,started_at)
    VALUES(?,?,?,?,'running',?,?)`).run(runId,triggerDocumentId,trigger.sha256,registryFingerprint,fields.length,startedAt);
  let searchedCount = 0;
  let evidenceCount = 0;
  let noEvidenceCount = 0;
  let ragflowQueries = 0;
  try {
    const pendingRemote = [];
    const save = database.transaction((candidates) => {
      for (const candidate of candidates) insertCandidate(database, candidate);
    });
    for (const field of fields) {
      const candidates = buildLocalCandidates(database,field,field.aliases,triggerDocumentId,runId,startedAt);
      searchedCount += 1;
      if (candidates.length) {
        evidenceCount += candidates.length;
        save(candidates);
      } else if (typeof options.retrieve === 'function' && pendingRemote.length < RAGFLOW_FIELD_BATCH_LIMIT) {
        pendingRemote.push(field);
      } else {
        noEvidenceCount += 1;
        save([noEvidenceCandidate(runId,field,'not-searched-remotely','no-local-evidence-and-ragflow-unavailable-or-query-limit',startedAt)]);
      }
    }
    await mapLimit(pendingRemote,MAX_QUERY_CONCURRENCY,async (field) => {
      ragflowQueries += 1;
      try {
        const candidates = await buildRagCandidates(database,field,runId,startedAt,options.retrieve);
        if (candidates.length) {
          evidenceCount += candidates.length;
          save(candidates);
        } else {
          noEvidenceCount += 1;
          save([noEvidenceCandidate(runId,field,'ragflow-no-hit','not-found-in-local-or-ragflow-search',startedAt)]);
        }
      } catch (error) {
        noEvidenceCount += 1;
        save([noEvidenceCandidate(runId,field,'ragflow-unavailable',String(error?.message ?? error).slice(0,500),startedAt)]);
      }
    });
    const completedAt = new Date().toISOString();
    database.prepare(`UPDATE field_discovery_runs SET status='completed',searched_count=?,evidence_count=?,no_evidence_count=?,ragflow_queries=?,completed_at=? WHERE id=?`)
      .run(searchedCount,evidenceCount,noEvidenceCount,ragflowQueries,completedAt,runId);
    return { runId,triggerDocumentId,fieldCount:fields.length,searchedCount,evidenceCount,noEvidenceCount,ragflowQueries,status:'completed' };
  } catch (error) {
    database.prepare(`UPDATE field_discovery_runs SET status='failed',searched_count=?,evidence_count=?,no_evidence_count=?,ragflow_queries=?,error_text=?,completed_at=? WHERE id=?`)
      .run(searchedCount,evidenceCount,noEvidenceCount,ragflowQueries,String(error?.message ?? error).slice(0,2000),new Date().toISOString(),runId);
    throw error;
  }
}

function listCandidates(database, documentId) {
  const run = database.prepare(`SELECT id,trigger_document_id,trigger_sha256,status,field_count,searched_count,evidence_count,ragflow_queries,error_text,started_at,completed_at
    FROM field_discovery_runs WHERE trigger_document_id=? ORDER BY started_at DESC LIMIT 1`).get(String(documentId));
  if (!run) return { run: null, rows: [] };
  const rows = database.prepare(`SELECT candidate.id,candidate.field_code,candidate.entity_type,candidate.field_key,candidate.field_label_ar,candidate.data_type,candidate.unit,candidate.field_class,
    candidate.source_document_id,candidate.source_file_name,candidate.source_sha256,candidate.page_number,candidate.source_location_json,candidate.search_terms_json,candidate.retrieval_method,
    candidate.retrieval_reference_json,candidate.evidence_text,candidate.raw_value,candidate.suggested_value,candidate.confidence,candidate.validation_status,candidate.review_status,candidate.reviewed_value_json,candidate.review_note,candidate.reviewed_by,candidate.reviewed_at,candidate.created_at,candidate.updated_at,
    promotion.form_record_id AS promoted_form_record_id
    FROM document_field_candidates candidate LEFT JOIN document_candidate_promotions promotion ON promotion.candidate_id=candidate.id
    WHERE candidate.run_id=? ORDER BY candidate.entity_type,candidate.field_class,candidate.field_label_ar,candidate.source_file_name`).all(run.id).map((row) => ({
    ...row,
    sourceLocation: parseJson(row.source_location_json, {}),
    searchTerms: parseJson(row.search_terms_json, []),
    retrievalReference: parseJson(row.retrieval_reference_json, {}),
    reviewedValue: parseJson(row.reviewed_value_json, null),
  }));
  return { run, rows };
}

function reviewCandidate(database, request = {}) {
  const candidateId = String(request.candidateId ?? '');
  const status = String(request.status ?? '');
  if (!candidateId || !['reviewed','rejected'].includes(status)) throw new Error('قرار مراجعة المرشح غير صالح.');
  const value = request.value === undefined || request.value === null ? null : String(request.value).slice(0, 1000);
  if (status === 'reviewed' && !String(value ?? '').trim()) throw new Error('أدخل القيمة التي تحققت منها قبل تسجيل المراجعة.');
  const note = String(request.note ?? '').trim().slice(0, 1000);
  if (!note) throw new Error('اكتب سبب قرار مراجعة المرشح.');
  const reviewedBy = String(request.reviewedBy ?? 'local-owner').slice(0, 100);
  const now = new Date().toISOString();
  const update = database.transaction(() => {
    const current = database.prepare('SELECT id,review_status FROM document_field_candidates WHERE id=?').get(candidateId);
    if (!current) throw new Error('المرشح غير موجود.');
    if (current.review_status !== 'pending') throw new Error('تمت مراجعة هذا المرشح سابقًا.');
    const result = database.prepare(`UPDATE document_field_candidates
      SET review_status=?,reviewed_value_json=?,review_note=?,reviewed_by=?,reviewed_at=?,updated_at=?
      WHERE id=? AND review_status='pending'`)
      .run(status,value === null ? null : JSON.stringify({ value }),note,reviewedBy,now,now,candidateId);
    if (result.changes !== 1) throw new Error('تغيرت حالة المرشح قبل حفظ القرار.');
  });
  update();
  return { candidateId, status, reviewedBy, reviewedAt: now, officialDataChanged: false, updatedAt: now };
}

function promoteReviewedCandidates(database, request = {}, options = {}) {
  const documentId = String(request.documentId ?? '');
  const formVersionId = Number(request.formVersionId);
  const candidateIds = [...new Set((Array.isArray(request.candidateIds) ? request.candidateIds : []).map((id) => String(id)).filter(Boolean))];
  if (!documentId || !Number.isSafeInteger(formVersionId) || formVersionId <= 0 || candidateIds.length === 0 || candidateIds.length > 100) {
    throw new Error('حدد الوثيقة والنموذج وحقولًا مراجعة صالحة لإرسالها للاعتماد.');
  }
  const actor = typeof options.actor === 'string' ? options.actor.slice(0,120) : null;
  const now = new Date().toISOString();
  return database.transaction(() => {
    const trigger = database.prepare('SELECT id FROM document_records WHERE id=?').get(documentId);
    if (!trigger) throw new Error('الوثيقة غير موجودة.');
    const placeholders = candidateIds.map(() => '?').join(',');
    const candidates = database.prepare(`SELECT candidate.*,source_document.source_id AS source_database_id,source_document.file_name AS original_file_name,
      promotion.form_record_id AS promoted_form_record_id
      FROM document_field_candidates candidate
      LEFT JOIN document_records source_document ON source_document.id=candidate.source_document_id
      LEFT JOIN document_candidate_promotions promotion ON promotion.candidate_id=candidate.id
      WHERE candidate.id IN (${placeholders}) AND candidate.run_id IN (
        SELECT id FROM field_discovery_runs WHERE trigger_document_id=?
      ) ORDER BY candidate.field_code`).all(...candidateIds,documentId);
    if (candidates.length !== candidateIds.length) throw new Error('بعض المرشحين لا ينتمون إلى هذه الوثيقة أو لم يعودوا موجودين.');
    if (candidates.some((candidate) => candidate.review_status !== 'reviewed' || candidate.promoted_form_record_id)) {
      throw new Error('لا يمكن ترحيل إلا المرشحين المراجَعين وغير المرحّلين سابقًا.');
    }
    if (new Set(candidates.map((candidate) => candidate.field_code)).size !== candidates.length) {
      throw new Error('اختر مرشحًا واحدًا فقط لكل حقل في السجل.');
    }
    const definition = recordService.getFormDefinition(database,formVersionId);
    const fields = new Map(definition.fields.map((field) => [field.field_code,field]));
    const mappings = request.fieldMappings && typeof request.fieldMappings === 'object' && !Array.isArray(request.fieldMappings) ? request.fieldMappings : {};
    const values = {};
    const sourceByField = {};
    const targetFields = new Map();
    const candidateTargets = new Map();
    for (const candidate of candidates) {
      const targetCode = String(mappings[candidate.id] ?? candidate.field_code);
      const field = fields.get(targetCode);
      if (!field) throw new Error(`اربط الحقل «${candidate.field_label_ar}» بحقل موجود في النموذج المحدد.`);
      const targetType = field.data_type_override ?? field.data_type;
      if (!compatibleDataTypes(targetType,candidate.data_type)) throw new Error(`نوع الحقل «${field.label_ar}» لا يطابق نوع الحقل المستخرج «${candidate.data_type}».`);
      if (!field.is_importable || field.is_derived || field.storage_class === 'ignored_derived') {
        throw new Error(`الحقل «${field.label_ar}» مشتق أو غير قابل للإدخال.`);
      }
      if (!candidate.source_database_id) throw new Error(`مصدر الدليل للحقل «${candidate.field_label_ar}» غير موجود.`);
      const reviewedValue = parseJson(candidate.reviewed_value_json,null)?.value;
      if (reviewedValue === undefined || reviewedValue === null || String(reviewedValue).trim() === '') {
        throw new Error(`أدخل قيمة مؤكدة للحقل «${candidate.field_label_ar}» قبل الترحيل.`);
      }
      if (targetFields.has(field.form_field_id)) throw new Error(`تم ربط أكثر من مرشح بالحقل «${field.label_ar}».`);
      targetFields.set(field.form_field_id,field);
      candidateTargets.set(candidate.id,field);
      values[targetCode] = { value:String(reviewedValue),state:'known' };
      sourceByField[targetCode] = {
        dataSourceId:candidate.source_database_id,
        sourceLocator:JSON.stringify({
          documentId:candidate.source_document_id,
          fileName:candidate.original_file_name,
          sha256:candidate.source_sha256,
          pageNumber:candidate.page_number,
          elementId:candidate.source_element_id,
          retrievalMethod:candidate.retrieval_method,
          retrievalReference:parseJson(candidate.retrieval_reference_json,{}),
          candidateId:candidate.id,
        }),
      };
    }
    const saved = recordService.saveRecordFromDocument(database,{
      formVersionId,
      geoUnitId:request.geoUnitId ?? null,
      periodId:request.periodId ?? null,
      periodYear:request.periodYear ?? null,
      recordLabel:String(request.recordLabel ?? '').trim().slice(0,240) || null,
      notes:String(request.notes ?? 'قِيَم مرشحة من وثائق؛ يلزم اعتماد السجل قبل ظهورها ضمن البيانات الرسمية.').trim().slice(0,1000),
      values,
      actor,
    },{ sourceByField });
    const submitted = recordService.submitForReview(database,saved.formRecordId,actor);
    const insertPromotion = database.prepare(`INSERT INTO document_candidate_promotions(candidate_id,form_record_id,form_field_id,source_id,promoted_by,promoted_at)
      VALUES(?,?,?,?,?,?)`);
    for (const candidate of candidates) {
      const target = candidateTargets.get(candidate.id);
      const sourceId = database.prepare('SELECT source_id FROM data_sources WHERE id=?').get(candidate.source_database_id)?.source_id;
      if (!sourceId) throw new Error('تعذر ربط مصدر الدليل بالسجل المعياري.');
      insertPromotion.run(candidate.id,saved.formRecordId,target.form_field_id,sourceId,actor,now);
    }
    return { formRecordId:saved.formRecordId,status:submitted.status,candidateIds,fieldCount:candidates.length,sourceId:saved.sourceId };
  })();
}

module.exports = {
  SCHEMA,
  checksum: () => crypto.createHash('sha256').update(SCHEMA).digest('hex'),
  migrate,
  normalizeSearchText,
  fieldRegistry,
  makeRagQuestion,
  discoverFields,
  listCandidates,
  reviewCandidate,
  promoteReviewedCandidates,
};
