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

const MAX_LOCAL_EVIDENCE_PER_FIELD = 50000;
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

function candidateRecordGroupKey(candidate) {
  const source = parseJson(candidate.source_location_json,{}).source ?? {};
  const documentId = String(candidate.source_document_id ?? '');
  if (source.sheet_name && source.row_number) return `${documentId}:sheet:${source.sheet_name}:row:${source.row_number}`;
  if (source.table_number && source.row_number) return `${documentId}:table:${source.table_number}:row:${source.row_number}`;
  if (candidate.page_number) return `${documentId}:page:${candidate.page_number}`;
  return `${documentId}:document`;
}

function fieldRegistry(database) {
  const fields = database.prepare(`SELECT form_field.form_field_id,legacy_definition.id AS field_definition_id,
    form_field.field_definition_id AS manual_field_definition_id,
    CASE WHEN form.form_code='legacy_directorate_v1' THEN 'directorate' ELSE form.form_code END AS entity_type,
    form.form_code,form.name_ar AS form_name_ar,form_field.field_code,CASE WHEN instr(form_field.field_code,'.')>0 THEN substr(form_field.field_code,instr(form_field.field_code,'.')+1) ELSE form_field.field_code END AS field_key,
    CASE WHEN form_field.label_ar= form_field.field_code THEN COALESCE(definition.canonical_name_ar,form_field.label_ar) ELSE form_field.label_ar END AS label_ar,
    COALESCE(form_field.data_type_override,definition.data_type,'text') AS data_type,
    COALESCE(unit.name_ar,default_unit.name_ar) AS unit,form_field.storage_class AS field_class,
    form_field.is_required,form_field.allow_null,form_field.is_importable,form_field.is_derived,form_field.min_value,form_field.max_value,form_field.decimal_precision,
    form_field.validation_rules_json,COALESCE(form_field.reference_set_id,definition.reference_set_id) AS reference_set_id,
    COALESCE(form_reference.set_code,definition_reference.set_code) AS reference_set_code,
    version.form_version_id,section.name_ar AS section_name
    FROM form_fields form_field
    JOIN form_versions version ON version.form_version_id=form_field.form_version_id AND version.status='published'
    JOIN form_definitions form ON form.form_id=version.form_id AND form.is_active=1 AND form.form_code NOT LIKE 'raw_collection_v1_%'
    LEFT JOIN form_sections section ON section.form_version_id=version.form_version_id AND section.section_id=form_field.section_id
    LEFT JOIN data_field_definitions legacy_definition ON legacy_definition.entity_type || '.' || legacy_definition.field_key=form_field.field_code AND legacy_definition.active=1
    LEFT JOIN field_definitions definition ON definition.field_definition_id=form_field.field_definition_id
    LEFT JOIN measurement_units unit ON unit.unit_id=form_field.unit_id
    LEFT JOIN measurement_units default_unit ON default_unit.unit_id=definition.default_unit_id
    LEFT JOIN reference_sets form_reference ON form_reference.reference_set_id=form_field.reference_set_id
    LEFT JOIN reference_sets definition_reference ON definition_reference.reference_set_id=definition.reference_set_id
    WHERE form_field.is_importable=1 AND form_field.is_derived=0 AND form_field.storage_class NOT IN ('ignored_derived','review_decision')
      AND form_field.field_code NOT LIKE '%reviewerDecision%'
      AND version.version_number=(SELECT MAX(latest.version_number) FROM form_versions latest
        WHERE latest.form_id=version.form_id AND latest.status='published')
    ORDER BY form.form_code,form_field.sort_order,form_field.field_code`).all();
  const formPlacements = database.prepare(`SELECT group_form.form_code,domain.domain_code,domain.name_ar AS domain_name_ar,
      catalog_group.group_code,catalog_group.name_ar AS group_name_ar,domain.sort_order AS domain_order,catalog_group.sort_order AS group_order
    FROM manual_entry_group_forms group_form JOIN manual_entry_groups catalog_group USING(group_id)
    JOIN manual_entry_domains domain USING(domain_id) ORDER BY domain.sort_order,catalog_group.sort_order`).all();
  const placementByForm = new Map();
  for (const placement of formPlacements) if (!placementByForm.has(placement.form_code)) placementByForm.set(placement.form_code,placement);
  const registry = fields.map((field) => {
    const placement = placementByForm.get(field.form_code) ?? {};
    field.domain_code = placement.domain_code ?? '';
    field.domain_name = placement.domain_name_ar ?? 'مجال غير مصنف';
    field.group_code = placement.group_code ?? '';
    field.group_name = placement.group_name_ar ?? field.section_name ?? 'حقول النموذج';
    const aliases = new Set([field.label_ar,field.field_code,field.field_key].map(normalizeSearchText).filter(value => value.length >= 2));
    if (field.field_definition_id) {
      const approved = database.prepare(`SELECT alias FROM data_field_aliases
        WHERE field_definition_id=? AND approved=1 ORDER BY confidence DESC,id`).all(field.field_definition_id);
      for (const item of approved) {
        const alias = normalizeSearchText(item.alias);
        if (alias.length >= 2) aliases.add(alias);
      }
    }
    const formAliases = database.prepare(`SELECT DISTINCT alias.alias_text FROM form_field_aliases alias
      WHERE alias.form_field_id=? AND alias.is_approved=1 ORDER BY alias.confidence DESC,alias.field_alias_id LIMIT ?`).all(field.form_field_id,MAX_FIELD_ALIASES);
    for (const item of formAliases) {
      const alias = normalizeSearchText(item.alias_text);
      if (alias.length >= 2) aliases.add(alias);
    }
    const referenceValues = field.reference_set_id == null ? [] : database.prepare(`SELECT reference_value_id AS id,value_code AS code,label_ar AS label
      FROM reference_values WHERE reference_set_id=? AND is_active=1 ORDER BY sort_order,reference_value_id`).all(field.reference_set_id);
    const dimensions = database.prepare(`SELECT dimension.dimension_code AS code,dimension.name_ar AS name,dimension.is_required AS required,
        value.value_code AS valueCode,value.label_ar AS valueLabel
      FROM manual_entry_form_field_dimensions mapping
      JOIN dimension_definitions dimension ON dimension.dimension_id=mapping.dimension_id AND dimension.is_active=1
      LEFT JOIN dimension_values value ON value.dimension_id=dimension.dimension_id AND value.is_active=1
      WHERE mapping.form_field_id=? ORDER BY mapping.sort_order,value.sort_order`).all(field.form_field_id);
    const dimensionMap = new Map();
    for (const dimension of dimensions) {
      if (!dimensionMap.has(dimension.code)) dimensionMap.set(dimension.code,{ code:dimension.code,name:dimension.name,required:Boolean(dimension.required),values:[] });
      if (dimension.valueCode) dimensionMap.get(dimension.code).values.push({ code:dimension.valueCode,label:dimension.valueLabel });
    }
    return { ...field,form_field:true,aliases:[...aliases].slice(0,MAX_FIELD_ALIASES),referenceValues,dimensions:[...dimensionMap.values()] };
  });
  return registry;
}


function fuzzyHeaderScore(header, aliases) {
  const normalizedHeader = normalizeSearchText(header);
  if (normalizedHeader.length < 4) return 0;
  const headerTokens = normalizedHeader.split(/\s+/).filter(Boolean);
  let bestScore = 0;
  for (const alias of aliases) {
    const normalizedAlias = normalizeSearchText(alias);
    if (normalizedAlias === normalizedHeader || normalizedAlias.length < 4) continue;
    const aliasTokens = normalizedAlias.split(/\s+/).filter(Boolean);
    const tokenOverlap = 2 * headerTokens.filter(token => aliasTokens.includes(token)).length / Math.max(1,headerTokens.length + aliasTokens.length);
    const editScore = 1 - levenshteinDistance(normalizedHeader,normalizedAlias) / Math.max(normalizedHeader.length,normalizedAlias.length);
    bestScore = Math.max(bestScore,tokenOverlap,editScore);
  }
  return bestScore;
}

function levenshteinDistance(left, right) {
  let previous = Array.from({ length:right.length + 1 },(_,index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(current[rightIndex - 1] + 1,previous[rightIndex] + 1,previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

function buildLocalCandidates(database, field, aliases, triggerDocumentId, runId, now, nearRows = []) {
  const conditions = aliases.map(() => 'instr(element.search_text,?)>0').join(' OR ');
  if (!conditions) return [];
  const rows = database.prepare(`SELECT element.id AS element_id,element.document_id,document.file_name,document.sha256,
    element.element_type,element.heading,element.content,element.page_number,element.position_json,element.confidence,element.source_json
    FROM document_elements element JOIN document_records document ON document.id=element.document_id
    WHERE element.document_id=? AND (${conditions}) ORDER BY element.sequence_number
    LIMIT ?`).all(triggerDocumentId,...aliases,MAX_LOCAL_EVIDENCE_PER_FIELD);
  const exactRows = rows.map((row) => {
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
  const exactElementIds = new Set(rows.map(row => row.element_id));
  const nearCandidates = [];
  for (const row of nearRows) {
    if (exactElementIds.has(row.element_id)) continue;
    const lines = String(row.content ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/[:：=]/);
      if (parts.length < 2) continue;
      const label = parts.shift().trim();
      const rawValue = parts.join(':').trim().slice(0,500);
      if (!rawValue || aliases.some(alias => normalizeSearchText(label) === alias)) continue;
      const score = fuzzyHeaderScore(label,aliases);
      if (score < 0.72) continue;
      const sourceConfidence = row.confidence == null ? null : Number(row.confidence);
      const confidence = Math.max(0,Math.min(0.89,score * 0.78 * (Number.isFinite(sourceConfidence) ? 0.75 + sourceConfidence * 0.25 : 1)));
      nearCandidates.push({
        id:crypto.randomUUID(),runId,field,sourceDocumentId:row.document_id,sourceElementId:row.element_id,
        sourceFileName:row.file_name,sourceSha256:row.sha256,pageNumber:row.page_number,
        sourceLocation:{ pageNumber:row.page_number,position:parseJson(row.position_json,null),source:parseJson(row.source_json,{}) },
        searchTerms:aliases,retrievalMethod:'local-near-heading',retrievalReference:{ elementType:row.element_type,heading:row.heading,matchedHeading:label,headingSimilarity:score },
        evidenceText:line.slice(0,4000),rawValue,suggestedValue:normalizeCandidateValue(field,rawValue),confidence,
        validationStatus:'needs-human-field-match-confirmation',createdAt:now,
      });
      break;
    }
  }
  return [...exactRows,...nearCandidates];
}

function normalizeCandidateValue(field, value) {
  if (value == null) return null;
  const original = String(value).trim();
  const type = normalizeDataType(field.data_type);
  if (type === 'reference') {
    const normalized = normalizeSearchText(original);
    const matches = (field.referenceValues ?? []).filter(item => normalizeSearchText(item.label) === normalized || normalizeSearchText(item.code) === normalized);
    return matches.length === 1 ? String(matches[0].id) : original;
  }
  if (type === 'boolean') {
    const normalized = normalizeSearchText(original);
    if (['1','true','نعم','yes'].includes(normalized)) return 'true';
    if (['0','false','لا','no'].includes(normalized)) return 'false';
    return original;
  }
  if (!['integer','decimal'].includes(type)) return original;
  const digits = original.replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0));
  if (!/^[+-]?[\d\s٬,٫.]+$/.test(digits)) return original;
  const hasDecimalArabic = digits.includes('٫');
  const hasComma = digits.includes(',');
  const commaIsGrouping = !hasComma || /^[+-]?\d{1,3}(?:,\d{3})+$/.test(digits);
  if (!commaIsGrouping || hasDecimalArabic && /[.,]/.test(digits)) return original;
  return digits.replace(/[\s٬,]/g, '').replace(/٫/g, '.');
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

async function buildRagCandidates(database, field, runId, now, retrieve, documentId) {
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
    return source && source.id === documentId ? {
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
    const nearRows = database.prepare(`SELECT element.id AS element_id,element.document_id,document.file_name,document.sha256,
      element.element_type,element.heading,element.content,element.page_number,element.position_json,element.confidence,element.source_json
      FROM document_elements element JOIN document_records document ON document.id=element.document_id
      WHERE element.document_id=? AND (instr(element.content,':')>0 OR instr(element.content,'：')>0 OR instr(element.content,'=')>0)
      ORDER BY element.sequence_number LIMIT 5000`).all(triggerDocumentId);
    const save = database.transaction((candidates) => {
      for (const candidate of candidates) insertCandidate(database, candidate);
    });
    for (const field of fields) {
      const candidates = buildLocalCandidates(database,field,field.aliases,triggerDocumentId,runId,startedAt,nearRows);
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
        const candidates = await buildRagCandidates(database,field,runId,startedAt,options.retrieve,triggerDocumentId);
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

function documentContextSuggestions(database, documentId, rows) {
  const document = database.prepare('SELECT file_name FROM document_records WHERE id=?').get(documentId);
  const elements = database.prepare('SELECT content,source_json,page_number FROM document_elements WHERE document_id=? ORDER BY sequence_number').all(documentId);
  const allText = [document?.file_name ?? '',...elements.map(element => element.content ?? '')].join(' ');
  const normalizeYearDigits = text => String(text ?? '').replace(/[٠-٩]/g,digit => String(digit.charCodeAt(0)-0x0660)).replace(/[۰-۹]/g,digit => String(digit.charCodeAt(0)-0x06f0));
  const yearsIn = text => [...new Set((normalizeYearDigits(text).match(/\b(?:19|20|21|22)\d{2}\b/g) ?? []).map(Number))].filter(year => year >= 1900 && year <= 2200);
  const geoUnits = database.prepare(`SELECT unit.geo_unit_id,unit.name_ar,type.name_ar AS type_name_ar,parent.name_ar AS parent_name_ar
    FROM geographic_units unit JOIN geo_unit_types type ON type.geo_unit_type_id=unit.geo_unit_type_id
    LEFT JOIN geographic_units parent ON parent.geo_unit_id=unit.parent_geo_unit_id WHERE unit.is_active=1 ORDER BY unit.geo_unit_id`).all();
  const geographyIn = text => {
    const normalizedText = normalizeSearchText(text);
    const matches = geoUnits.filter(unit => normalizeSearchText(unit.name_ar).length >= 3 && normalizedText.includes(normalizeSearchText(unit.name_ar)));
    if (!matches.length) return null;
    const longest = Math.max(...matches.map(unit => normalizeSearchText(unit.name_ar).length));
    const best = matches.filter(unit => normalizeSearchText(unit.name_ar).length === longest);
    if (best.length !== 1) return { ambiguous:true,choices:best.map(unit => ({ id:unit.geo_unit_id,name:unit.name_ar,type:unit.type_name_ar,parent:unit.parent_name_ar })) };
    const unit = best[0];
    return { id:unit.geo_unit_id,name:unit.name_ar,type:unit.type_name_ar,parent:unit.parent_name_ar,confidence:0.8 };
  };
  const globalYears = yearsIn(allText);
  const global = {
    geography:geographyIn(allText),
    periodYear:globalYears.length === 1 ? globalYears[0] : null,
    periodConflict:globalYears.length > 1,
    periodAlternatives:globalYears.length > 1 ? globalYears : [],
  };
  const groupEntries = new Map();
  for (const candidate of rows) {
    const key = candidateRecordGroupKey(candidate);
    if (!groupEntries.has(key)) groupEntries.set(key,[]);
    groupEntries.get(key).push(candidate);
  }
  const groups = {};
  for (const [key,candidates] of groupEntries) {
    const source = candidates[0].sourceLocation?.source ?? {};
    const matchingElements = elements.filter(element => {
      const elementSource = parseJson(element.source_json,{});
      return source.sheet_name && source.sheet_name === elementSource.sheet_name && source.row_number && source.row_number === elementSource.row_number
        || source.table_number && source.table_number === elementSource.table_number && source.row_number && source.row_number === elementSource.row_number
        || candidates[0].page_number && candidates[0].page_number === element.page_number;
    });
    const groupText = matchingElements.map(element => element.content ?? '').join(' ');
    const years = yearsIn(groupText);
    const geography = geographyIn(groupText);
    groups[key] = {
      geography,
      periodYear:years.length === 1 ? years[0] : null,
      periodConflict:years.length > 1,
      periodAlternatives:years.length > 1 ? years : [],
    };
  }
  return { global,groups };
}

function listCandidates(database, documentId) {
  const run = database.prepare(`SELECT id,trigger_document_id,trigger_sha256,status,field_count,searched_count,evidence_count,ragflow_queries,error_text,started_at,completed_at
    FROM field_discovery_runs WHERE trigger_document_id=? ORDER BY started_at DESC LIMIT 1`).get(String(documentId));
  if (!run) return { run: null, rows: [] };
  const registry = fieldRegistry(database);
  const fieldMetadata = new Map(registry.map(field => [field.field_code,{ referenceValues:field.referenceValues,dimensions:field.dimensions }]));
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
    fieldMetadata:fieldMetadata.get(row.field_code) ?? { referenceValues:[],dimensions:[] },
  }));
  const fields = registry.map(field => ({
    formVersionId:field.form_version_id,formCode:field.form_code,formName:field.form_name_ar,
    fieldCode:field.field_code,label:field.label_ar,domainCode:field.domain_code,domainName:field.domain_name,
    groupCode:field.group_code,groupName:field.group_name,sectionName:field.section_name ?? 'حقول النموذج',
    dataType:field.data_type,unit:field.unit,isRequired:Boolean(field.is_required),isImportable:Boolean(field.is_importable),
    isDerived:Boolean(field.is_derived),fieldClass:field.field_class,referenceValues:field.referenceValues,dimensions:field.dimensions,
  }));
  const recordGroups = new Map();
  const sourceFileName = database.prepare('SELECT file_name FROM document_records WHERE id=?').get(String(documentId))?.file_name ?? 'وثيقة';
  const documentElements = database.prepare('SELECT source_json,page_number FROM document_elements WHERE document_id=? ORDER BY sequence_number').all(String(documentId));
  for (const element of documentElements) {
    const sourceLocation = { source:parseJson(element.source_json,{}) };
    const record = { source_document_id:String(documentId),source_location_json:JSON.stringify(sourceLocation),page_number:element.page_number };
    const key = candidateRecordGroupKey(record);
    if (!recordGroups.has(key)) {
      const source = sourceLocation.source;
      const locationLabel = source.sheet_name && source.row_number ? `${source.sheet_name} · الصف ${source.row_number}`
        : source.table_number && source.row_number ? `الجدول ${source.table_number} · الصف ${source.row_number}`
          : element.page_number ? `الصفحة ${element.page_number}` : 'الوثيقة كاملة';
      recordGroups.set(key,{ byField:new Map(),sourceLabel:`${sourceFileName} · ${locationLabel}` });
    }
  }
  for (const candidate of rows.filter(row => row.source_document_id)) {
    const key = candidateRecordGroupKey(candidate);
    if (!recordGroups.has(key)) recordGroups.set(key,{ byField:new Map(),sourceLabel:candidateSourceLabel(candidate) });
    const byField = recordGroups.get(key).byField;
    if (!byField.has(candidate.field_code)) byField.set(candidate.field_code,[]);
    if (candidate.review_status !== 'no_evidence') byField.get(candidate.field_code).push(candidate);
  }
  const records = [...recordGroups].map(([key,record]) => ({
    key,
    sourceLabel:record.sourceLabel,
    fields:[...record.byField].map(([fieldCode,evidence]) => {
      const valueGroups = new Map();
      for (const candidate of evidence) {
        const value = candidate.suggested_value ?? candidate.raw_value;
        if (value == null || String(value).trim() === '') continue;
        const normalized = normalizeSearchText(value);
        const bucket = valueGroups.get(normalized) ?? { value:String(value),candidateIds:[],maxConfidence:0,confidenceTotal:0 };
        bucket.candidateIds.push(candidate.id);
        bucket.maxConfidence = Math.max(bucket.maxConfidence,Number(candidate.confidence) || 0);
        bucket.confidenceTotal += Number(candidate.confidence) || 0;
        valueGroups.set(normalized,bucket);
      }
      const values = [...valueGroups.values()].map(bucket => ({
        ...bucket,evidenceCount:bucket.candidateIds.length,
        score:bucket.maxConfidence + Math.min(0.12,Math.log2(bucket.candidateIds.length) * 0.03),
      })).sort((left,right) => right.score-left.score || right.evidenceCount-left.evidenceCount);
      return {
        fieldCode,evidenceCount:evidence.length,values,recommendedValue:values[0]?.value ?? '',
        recommendedCandidateIds:values[0]?.candidateIds ?? [],
        recommendationReason:values.length > 1 ? `رُجّحت هذه القيمة بدرجة مطابقة/أدلة أعلى (${values[0].evidenceCount} دليلًا مقابل ${values[1].evidenceCount}).` : values[0]?.evidenceCount > 1 ? `توافقت ${values[0].evidenceCount} أدلة مستقلة.` : 'مطابقة مباشرة واحدة؛ يلزم التحقق البشري.',
        confidence:values[0]?.maxConfidence ?? null,
        candidates:evidence,
        status:evidence.some(candidate => candidate.review_status === 'reviewed') ? 'reviewed'
          : evidence.length && evidence.every(candidate => candidate.review_status === 'rejected') ? 'rejected'
            : evidence.length ? 'pending' : 'no_evidence',
        reviewedValue:evidence.find(candidate => candidate.reviewedValue)?.reviewedValue ?? null,
      };
    }),
  }));
  return { run,rows,fields,records,contextSuggestions:documentContextSuggestions(database,String(documentId),rows) };
}

function reviewCandidateGroup(database, request = {}) {
  const groups = Array.isArray(request.groups) ? request.groups : [request];
  if (!groups.length || groups.length > 100) throw new Error('حدد من 1 إلى 100 مجموعة حقول للمراجعة.');
  const reviewedBy = String(request.reviewedBy ?? 'local-owner').slice(0,100);
  const note = String(request.note ?? '').trim().slice(0,1000);
  if (!note) throw new Error('اكتب سبب قرار مراجعة الحقول.');
  const now = new Date().toISOString();
  return database.transaction(() => groups.map(group => {
    const status = String(group.status ?? 'reviewed');
    const ids = [...new Set((Array.isArray(group.candidateIds) ? group.candidateIds : []).map(String).filter(Boolean))];
    if (!ids.length || ids.length > 100 || !['reviewed','rejected'].includes(status)) throw new Error('مجموعة أدلة المراجعة غير صالحة.');
    const placeholders = ids.map(() => '?').join(',');
    const rows = database.prepare(`SELECT candidate.id,candidate.field_code,candidate.review_status,candidate.source_document_id,candidate.source_location_json,candidate.page_number
      FROM document_field_candidates candidate WHERE candidate.id IN (${placeholders}) AND candidate.run_id IN (
        SELECT id FROM field_discovery_runs WHERE trigger_document_id=?
      )`).all(...ids,String(request.documentId ?? ''));
    if (rows.length !== ids.length || new Set(rows.map(row => row.field_code)).size !== 1 || new Set(rows.map(candidateRecordGroupKey)).size !== 1) {
      throw new Error('يجب أن تنتمي الأدلة إلى الحقل والسجل المصدر نفسيهما.');
    }
    if (rows.some(row => row.review_status !== 'pending')) throw new Error('تتضمن المجموعة أدلة سبق اتخاذ قرار بشأنها.');
    let updates;
    if (status === 'rejected') {
      updates = rows.map(row => ({ id:row.id,status:'rejected',reviewedValue:null }));
    } else {
      const supportIds = [...new Set((Array.isArray(group.evidenceIds) ? group.evidenceIds : []).map(String).filter(Boolean))];
      const primaryId = String(group.primaryCandidateId ?? '');
      const value = String(group.value ?? '').trim().slice(0,1000);
      if (!value || !supportIds.length || !supportIds.includes(primaryId) || supportIds.some(id => !ids.includes(id))) {
        throw new Error('حدد قيمة مؤكدة ودليلًا ممثلًا ومصادر داعمة من المجموعة نفسها.');
      }
      const reviewedValue = JSON.stringify({ value,primaryCandidateId:primaryId,evidenceBundleIds:supportIds });
      updates = rows.map(row => ({ id:row.id,status:'reviewed',reviewedValue }));
    }
    const update = database.prepare(`UPDATE document_field_candidates SET review_status=?,reviewed_value_json=?,review_note=?,reviewed_by=?,reviewed_at=?,updated_at=?
      WHERE id=? AND review_status='pending'`);
    for (const item of updates) {
      const result = update.run(item.status,item.reviewedValue,note,reviewedBy,now,now,item.id);
      if (result.changes !== 1) throw new Error('تغيرت حالة أحد الأدلة قبل حفظ قرار المجموعة.');
    }
    return { fieldCode:rows[0].field_code,status,updatedCount:updates.length,primaryCandidateId:group.primaryCandidateId ?? null,reviewedBy,reviewedAt:now };
  }))();
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

function promoteReviewedCandidateGroups(database, request = {}, options = {}) {
  const groups = Array.isArray(request.candidateGroups) ? request.candidateGroups : [];
  if (groups.length === 0 || groups.length > 100) throw new Error('حدد مجموعة سجل واحدة على الأقل وبحد أقصى 100 مجموعة.');
  const saveAll = database.transaction(() => groups.map(group => promoteReviewedCandidates(database,{
    ...request,
    candidateGroups:undefined,
    candidateIds:group.candidateIds,
    fieldMappings:group.fieldMappings,
    dimensionValues:group.dimensionValues,
    geoUnitId:group.geoUnitId ?? request.geoUnitId,
    periodId:group.periodId ?? request.periodId,
    periodYear:group.periodYear ?? request.periodYear,
    recordLabel:String(group.recordLabel ?? request.recordLabel ?? '').trim().slice(0,240) || null,
  },options)));
  const records = saveAll();
  return { records, recordCount:records.length, fieldCount:records.reduce((total,record) => total + record.fieldCount,0) };
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
    if (definition.form_code.startsWith('raw_collection_v1_')) throw new Error('لا يمكن ترحيل المرشحين إلى نموذج التقاط خام غير مصنف.');
    if (new Set(candidates.map(candidateRecordGroupKey)).size !== 1) throw new Error('اختر القيم من صف أو صفحة مصدر واحدة لكل سجل جديد.');
    const fields = new Map(definition.fields.map((field) => [field.field_code,field]));
    const mappings = request.fieldMappings && typeof request.fieldMappings === 'object' && !Array.isArray(request.fieldMappings) ? request.fieldMappings : {};
    const values = {};
    const dimensionValues = {};
    const sourceByField = {};
    const targetFields = new Map();
    const candidateTargets = new Map();
    for (const candidate of candidates) {
      const targetCode = String(mappings[candidate.id] ?? candidate.field_code);
      const field = fields.get(targetCode);
      if (!field) throw new Error(`اربط الحقل «${candidate.field_label_ar}» بحقل موجود في النموذج المحدد.`);
      if (targetCode !== candidate.field_code) throw new Error(`لا يمكن ربط المرشح «${candidate.field_label_ar}» بحقل مختلف دون مطابقة دلالية معتمدة.`);
      const targetType = field.data_type_override ?? field.data_type;
      if (!compatibleDataTypes(targetType,candidate.data_type)) throw new Error(`نوع الحقل «${field.label_ar}» لا يطابق نوع الحقل المستخرج «${candidate.data_type}».`);
      if (!field.is_importable || field.is_derived || field.storage_class === 'ignored_derived') {
        throw new Error(`الحقل «${field.label_ar}» مشتق أو غير قابل للإدخال.`);
      }
      if (!candidate.source_database_id) throw new Error(`مصدر الدليل للحقل «${candidate.field_label_ar}» غير موجود.`);
      const reviewedMetadata = parseJson(candidate.reviewed_value_json,null);
      const reviewedValue = reviewedMetadata?.value;
      if (reviewedValue === undefined || reviewedValue === null || String(reviewedValue).trim() === '') {
        throw new Error(`أدخل قيمة مؤكدة للحقل «${candidate.field_label_ar}» قبل الترحيل.`);
      }
      if (targetFields.has(field.form_field_id)) throw new Error(`تم ربط أكثر من مرشح بالحقل «${field.label_ar}».`);
      targetFields.set(field.form_field_id,field);
      candidateTargets.set(candidate.id,field);
      values[targetCode] = { value:String(reviewedValue),state:'known' };
      if (field.dimensions?.length) {
        const suppliedDimensions = request.dimensionValues?.[candidate.id];
        if (!suppliedDimensions || typeof suppliedDimensions !== 'object' || Array.isArray(suppliedDimensions)) {
          throw new Error(`اختر أبعاد القياس للحقل «${field.label_ar}» قبل الترحيل.`);
        }
        dimensionValues[targetCode] = suppliedDimensions;
      }
      sourceByField[targetCode] = {
        dataSourceId:candidate.source_database_id,
        sourceLocator:JSON.stringify({
          documentId:candidate.source_document_id,
          fileName:candidate.original_file_name,
          sha256:candidate.source_sha256,
          pageNumber:candidate.page_number,
          elementId:candidate.source_element_id,
          sourceLocation:parseJson(candidate.source_location_json,{}),
          evidenceText:candidate.evidence_text,
          rawValue:candidate.raw_value,
          suggestedValue:candidate.suggested_value,
          confidence:candidate.confidence,
          retrievalMethod:candidate.retrieval_method,
          retrievalReference:parseJson(candidate.retrieval_reference_json,{}),
          candidateId:candidate.id,
          evidenceBundle:database.prepare(`SELECT id,source_file_name,source_sha256,page_number,source_location_json,evidence_text,raw_value,suggested_value,confidence,retrieval_method,retrieval_reference_json
            FROM document_field_candidates WHERE id IN (${(reviewedMetadata.evidenceBundleIds ?? [candidate.id]).map(() => '?').join(',')})`).all(...(reviewedMetadata.evidenceBundleIds ?? [candidate.id])).map(evidence => ({
              candidateId:evidence.id,fileName:evidence.source_file_name,sha256:evidence.source_sha256,pageNumber:evidence.page_number,
              sourceLocation:parseJson(evidence.source_location_json,{}),evidenceText:evidence.evidence_text,rawValue:evidence.raw_value,
              suggestedValue:evidence.suggested_value,confidence:evidence.confidence,retrievalMethod:evidence.retrieval_method,
              retrievalReference:parseJson(evidence.retrieval_reference_json,{}),
            })),
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
      dimensionValues,
      actor,
    },{ sourceByField });
    const submitted = request.submitForReview === false ? null : recordService.submitForReview(database,saved.formRecordId,actor);
    const insertPromotion = database.prepare(`INSERT INTO document_candidate_promotions(candidate_id,form_record_id,form_field_id,source_id,promoted_by,promoted_at)
      VALUES(?,?,?,?,?,?)`);
    for (const candidate of candidates) {
      const target = candidateTargets.get(candidate.id);
      const sourceId = database.prepare('SELECT source_id FROM data_sources WHERE id=?').get(candidate.source_database_id)?.source_id;
      if (!sourceId) throw new Error('تعذر ربط مصدر الدليل بالسجل المعياري.');
      insertPromotion.run(candidate.id,saved.formRecordId,target.form_field_id,sourceId,actor,now);
    }
    return { formRecordId:saved.formRecordId,status:submitted?.status ?? saved.status,candidateIds,fieldCount:candidates.length,sourceId:saved.sourceId };
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
  reviewCandidateGroup,
  promoteReviewedCandidates,
  promoteReviewedCandidateGroups,
};
