'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { INPUT_FIELDS, DECISION_FIELD, INDICATORS } = require('./schema.cjs');

const LIMITS = Object.freeze({
  sheets: 200, rowsPerSheet: 5000, columnsPerSheet: 400,
  totalRows: 60000, totalCells: 500000, headerRows: 200,
  mediaCount: 1000, mediaItemBytes: 20 * 1024 * 1024,
  mediaTotalBytes: 60 * 1024 * 1024, originalFileBytes: 200 * 1024 * 1024
});

const TABLES = [
  "CREATE TABLE IF NOT EXISTS geographic_units (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES geographic_units(id), unit_type TEXT NOT NULL, official_code TEXT, name TEXT NOT NULL, normalized_name TEXT NOT NULL, valid_from TEXT, valid_to TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(unit_type, official_code))",
  "CREATE INDEX IF NOT EXISTS geographic_units_parent_idx ON geographic_units(parent_id, unit_type)",
  "CREATE TABLE IF NOT EXISTS sectors (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name_ar TEXT NOT NULL, description TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS data_sources (id INTEGER PRIMARY KEY, source_type TEXT NOT NULL, organization TEXT, document_title TEXT, file_name TEXT, mime_type TEXT, content_sha256 TEXT, file_size INTEGER, reference_period TEXT, collected_at TEXT, received_at TEXT NOT NULL, notes TEXT)",
  "CREATE INDEX IF NOT EXISTS data_sources_hash_idx ON data_sources(content_sha256)",
  "CREATE TABLE IF NOT EXISTS data_field_definitions (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, field_key TEXT NOT NULL, label_ar TEXT NOT NULL, data_type TEXT NOT NULL, unit TEXT, sensitivity TEXT NOT NULL DEFAULT 'public', required_for_identity INTEGER NOT NULL DEFAULT 0, description TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(entity_type, field_key))",
  "CREATE TABLE IF NOT EXISTS data_field_aliases (id INTEGER PRIMARY KEY, field_definition_id INTEGER NOT NULL REFERENCES data_field_definitions(id) ON DELETE CASCADE, alias TEXT NOT NULL, normalized_alias TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'ar', confidence REAL NOT NULL DEFAULT 1, approved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(field_definition_id, normalized_alias, locale))",
  "CREATE INDEX IF NOT EXISTS data_field_aliases_lookup_idx ON data_field_aliases(normalized_alias, approved)",
  "CREATE TABLE IF NOT EXISTS entity_records (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, geographic_unit_id INTEGER REFERENCES geographic_units(id), sector_id INTEGER REFERENCES sectors(id), external_key TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS entity_records_geo_idx ON entity_records(geographic_unit_id, entity_type)",
  "CREATE TABLE IF NOT EXISTS entity_field_values (id INTEGER PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES entity_records(id) ON DELETE CASCADE, field_definition_id INTEGER NOT NULL REFERENCES data_field_definitions(id), period_key TEXT NOT NULL DEFAULT '', value_text TEXT, value_number REAL, value_date TEXT, value_boolean INTEGER, value_state TEXT NOT NULL DEFAULT 'known', valid_from TEXT, valid_to TEXT, source_id INTEGER REFERENCES data_sources(id), source_location TEXT, raw_value_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(record_id, field_definition_id, period_key))",
  "CREATE INDEX IF NOT EXISTS entity_field_values_field_idx ON entity_field_values(field_definition_id, period_key)",
  "CREATE TABLE IF NOT EXISTS indicator_definitions (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, label_ar TEXT NOT NULL, sector_id INTEGER REFERENCES sectors(id), unit TEXT, direction TEXT, formula_json TEXT, methodology TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS indicator_observations (id INTEGER PRIMARY KEY, indicator_id INTEGER NOT NULL REFERENCES indicator_definitions(id), geographic_unit_id INTEGER NOT NULL REFERENCES geographic_units(id), period_key TEXT NOT NULL, period_start TEXT, period_end TEXT, value_number REAL, value_text TEXT, value_state TEXT NOT NULL DEFAULT 'known', source_id INTEGER REFERENCES data_sources(id), source_location TEXT, created_at TEXT NOT NULL, UNIQUE(indicator_id, geographic_unit_id, period_key))",
  "CREATE INDEX IF NOT EXISTS indicator_observations_period_idx ON indicator_observations(period_key, indicator_id)",
  "CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, description TEXT, geographic_unit_id INTEGER REFERENCES geographic_units(id), sector_id INTEGER REFERENCES sectors(id), status TEXT NOT NULL DEFAULT 'draft', estimated_cost REAL, actual_cost REAL, currency_code TEXT, start_date TEXT, end_date TEXT, source_id INTEGER REFERENCES data_sources(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS projects_geo_sector_idx ON projects(geographic_unit_id, sector_id, status)",
  "CREATE TABLE IF NOT EXISTS project_funding (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, partner_name TEXT NOT NULL, amount REAL, currency_code TEXT, funding_date TEXT, source_id INTEGER REFERENCES data_sources(id), created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS managed_attachments (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER, source_id INTEGER REFERENCES data_sources(id), original_name TEXT NOT NULL, mime_type TEXT, extension TEXT, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, content BLOB NOT NULL, source_location TEXT, classification TEXT NOT NULL DEFAULT 'unclassified', review_status TEXT NOT NULL DEFAULT 'unassigned', created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS managed_attachments_entity_idx ON managed_attachments(entity_type, entity_id)",
  "CREATE TABLE IF NOT EXISTS data_quality_issues (id INTEGER PRIMARY KEY, batch_id INTEGER, sheet_id INTEGER, row_id INTEGER, record_id INTEGER REFERENCES entity_records(id), field_definition_id INTEGER REFERENCES data_field_definitions(id), severity TEXT NOT NULL, issue_code TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, created_at TEXT NOT NULL, resolved_at TEXT)",
  "CREATE INDEX IF NOT EXISTS data_quality_issues_status_idx ON data_quality_issues(status, severity)",
  "CREATE TABLE IF NOT EXISTS workbook_import_batches (id INTEGER PRIMARY KEY, source_id INTEGER REFERENCES data_sources(id), file_name TEXT NOT NULL, file_size INTEGER NOT NULL, sha256 TEXT NOT NULL, original_file BLOB NOT NULL, sheet_count INTEGER NOT NULL DEFAULT 0, row_count INTEGER NOT NULL DEFAULT 0, cell_count INTEGER NOT NULL DEFAULT 0, media_count INTEGER NOT NULL DEFAULT 0, media_stored_count INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'staged', result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS workbook_import_batches_created_idx ON workbook_import_batches(created_at DESC)",
  "CREATE TABLE IF NOT EXISTS workbook_import_sheets (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES workbook_import_batches(id) ON DELETE CASCADE, worksheet_id INTEGER, sheet_index INTEGER NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, max_row INTEGER NOT NULL DEFAULT 0, max_column INTEGER NOT NULL DEFAULT 0, scanned_rows INTEGER NOT NULL DEFAULT 0, nonempty_row_count INTEGER NOT NULL DEFAULT 0, cell_count INTEGER NOT NULL DEFAULT 0, formula_count INTEGER NOT NULL DEFAULT 0, hidden_row_count INTEGER NOT NULL DEFAULT 0, merged_ranges_json TEXT NOT NULL DEFAULT '[]', tables_json TEXT NOT NULL DEFAULT '[]', image_count INTEGER NOT NULL DEFAULT 0, anchor_count INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, UNIQUE(batch_id, sheet_index))",
  "CREATE TABLE IF NOT EXISTS workbook_import_regions (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES workbook_import_batches(id) ON DELETE CASCADE, sheet_id INTEGER NOT NULL REFERENCES workbook_import_sheets(id) ON DELETE CASCADE, region_index INTEGER NOT NULL, header_row INTEGER NOT NULL, first_data_row INTEGER NOT NULL, last_data_row INTEGER NOT NULL, candidate_type TEXT NOT NULL DEFAULT 'unclassified', match_count INTEGER NOT NULL DEFAULT 0, confidence REAL NOT NULL DEFAULT 0, mapping_json TEXT NOT NULL, review_status TEXT NOT NULL DEFAULT 'unmapped', UNIQUE(sheet_id, region_index))",
  "CREATE TABLE IF NOT EXISTS workbook_import_rows (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES workbook_import_batches(id) ON DELETE CASCADE, sheet_id INTEGER NOT NULL REFERENCES workbook_import_sheets(id) ON DELETE CASCADE, row_number INTEGER NOT NULL, is_hidden INTEGER NOT NULL DEFAULT 0, cell_count INTEGER NOT NULL DEFAULT 0, has_formula INTEGER NOT NULL DEFAULT 0, cells_json TEXT NOT NULL, content_sha256 TEXT NOT NULL, UNIQUE(sheet_id, row_number))",
  "CREATE INDEX IF NOT EXISTS workbook_import_rows_batch_idx ON workbook_import_rows(batch_id, sheet_id, row_number)",
  "CREATE TABLE IF NOT EXISTS workbook_import_promotions (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES workbook_import_batches(id) ON DELETE CASCADE, region_id INTEGER NOT NULL REFERENCES workbook_import_regions(id) ON DELETE CASCADE, row_id INTEGER NOT NULL REFERENCES workbook_import_rows(id) ON DELETE CASCADE, entity_type TEXT NOT NULL, target_id INTEGER NOT NULL, source_location TEXT NOT NULL, mapping_json TEXT NOT NULL, mapped_values_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(row_id))",
  "CREATE INDEX IF NOT EXISTS workbook_import_promotions_target_idx ON workbook_import_promotions(entity_type, target_id)",
  "CREATE TABLE IF NOT EXISTS workbook_import_media (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES workbook_import_batches(id) ON DELETE CASCADE, sheet_id INTEGER REFERENCES workbook_import_sheets(id) ON DELETE SET NULL, media_index INTEGER NOT NULL, original_name TEXT NOT NULL, extension TEXT, mime_type TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT, content BLOB, anchors_json TEXT NOT NULL DEFAULT '[]', extraction_status TEXT NOT NULL DEFAULT 'stored', UNIQUE(batch_id, media_index))"
];

function normalizeLabel(value) {
  return String(value ?? '').normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}
function json(value) { try { return JSON.stringify(value); } catch { return 'null'; } }
function safeDateValue(value) {
  if (!(value instanceof Date)) return value;
  return Number.isFinite(value.getTime()) ? value.toISOString() : { type: 'invalid-date', text: String(value) };
}
function plainText(value) {
  if (value == null) return '';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date';
  if (['string','number','boolean'].includes(typeof value)) return String(value);
  if (Array.isArray(value.richText)) return value.richText.map(x => x.text ?? '').join('');
  if (value.text !== undefined) return String(value.text);
  if (value.result !== undefined) return plainText(value.result);
  if (value.hyperlink) return String(value.hyperlink);
  return '';
}
function snapshotCell(cell) {
  const value = cell.value;
  const formula = value && typeof value === 'object' ? value.formula ?? value.sharedFormula ?? null : null;
  const cached = value && typeof value === 'object' && Object.hasOwn(value, 'result') ? value.result : null;
  let note = null;
  try { note = typeof cell.note === 'string' ? cell.note : cell.note ? json(cell.note) : null; } catch {}
  return { address: cell.address, row: cell.row, column: cell.col, type: cell.type,
    text: plainText(value), formula, cachedResult: safeDateValue(cached), rawValue: safeDateValue(value), note };
}
function mediaBuffer(item) {
  if (Buffer.isBuffer(item?.buffer)) return item.buffer;
  if (item?.buffer instanceof Uint8Array) return Buffer.from(item.buffer);
  if (typeof item?.base64 === 'string') return Buffer.from(item.base64.includes(',') ? item.base64.split(',').pop() : item.base64, 'base64');
  return null;
}
function mimeFor(ext) {
  return ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',tif:'image/tiff',tiff:'image/tiff',svg:'image/svg+xml',webp:'image/webp'})[String(ext ?? '').toLowerCase()] ?? 'application/octet-stream';
}
function anchorsFor(sheet, media) {
  let images = [];
  try { images = sheet.getImages?.() ?? []; } catch {}
  return images.map(image => {
    const r = image.range ?? {};
    const match = media.find(item => String(item.index) === String(image.imageId));
    return { imageId: String(image.imageId), mediaIndex: match?.index ?? null,
      range: { topRow: r.tl?.nativeRow ?? r.tl?.row ?? null, leftColumn: r.tl?.nativeCol ?? r.tl?.col ?? null,
        bottomRow: r.br?.nativeRow ?? r.br?.row ?? null, rightColumn: r.br?.nativeCol ?? r.br?.col ?? null } };
  });
}

function migrateCanonicalData(database) {
  database.exec(TABLES.join(';\n') + ';');
  const now = new Date().toISOString();
  const fieldInsert = database.prepare("INSERT INTO data_field_definitions (entity_type,field_key,label_ar,data_type,unit,sensitivity,required_for_identity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_type,field_key) DO NOTHING");
  const aliasInsert = database.prepare("INSERT INTO data_field_aliases (field_definition_id,alias,normalized_alias,locale,confidence,approved,created_at) VALUES (?,?,?,'ar',1,1,?) ON CONFLICT(field_definition_id,normalized_alias,locale) DO NOTHING");
  // Reuse the exact Arabic aliases already accepted by the existing matcher.
  // Load lazily: mapping.cjs imports store-schema.cjs, so loading it only when
  // the migration executes avoids a module-initialization cycle.
  const { ALIASES } = require('./mapping.cjs');
  for (const field of [...INPUT_FIELDS, DECISION_FIELD]) {
    fieldInsert.run('directorate', field.key, field.header, field.type === 'ratio' ? 'number' : field.type,
      field.unit ?? null, field.sensitivity ?? 'public', ['districtName','governorate'].includes(field.key) ? 1 : 0, now, now);
    const id = database.prepare("SELECT id FROM data_field_definitions WHERE entity_type='directorate' AND field_key=?").get(field.key)?.id;
    if (id) {
      aliasInsert.run(id, field.header, normalizeLabel(field.header), now);
      for (const alias of ALIASES[field.key] ?? []) {
        aliasInsert.run(id, alias, normalizeLabel(alias), now);
      }
    }
  }
  const indicatorInsert = database.prepare("INSERT INTO indicator_definitions (code,label_ar,unit,direction,formula_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING");
  for (const indicator of INDICATORS) {
    indicatorInsert.run(indicator.code, indicator.header, indicator.unit ?? null, indicator.direction ?? null,
      json({ formula: indicator.formula, weight: indicator.weight, benchmark: indicator.benchmark ?? null }), now, now);
  }
  return true;
}

async function stageWorkbook(database, filePath, workbookOption = null) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 1) throw new Error('لا يمكن حفظ ملف استقبال فارغ.');
  if (stat.size > LIMITS.originalFileBytes) throw new Error('حجم الملف يتجاوز حد الحفظ المحلي البالغ 200 ميغابايت.');
  const original = fs.readFileSync(filePath);
  const sha = crypto.createHash('sha256').update(original).digest('hex');
  const workbook = workbookOption ?? new ExcelJS.Workbook();
  if (!workbookOption) await workbook.xlsx.load(original);
  const sheets = workbook.worksheets ?? [];
  if (!sheets.length) throw new Error('ملف Excel لا يحتوي أوراق عمل.');
  if (sheets.length > LIMITS.sheets) throw new Error('عدد الأوراق يتجاوز الحد الآمن: ' + LIMITS.sheets + '.');

  const { mapHeaderRow } = require('./mapping.cjs');
  const mediaAll = (workbook.model?.media ?? []).filter(item => item?.type === 'image' || item?.type === 'background');
  if (mediaAll.length > LIMITS.mediaCount) throw new Error('عدد الصور يتجاوز الحد الآمن: ' + LIMITS.mediaCount + '.');
  let totalRows = 0, totalCells = 0, formulaCount = 0, hiddenRowCount = 0, truncated = false;
  const inventory = [];

  for (let si = 0; si < sheets.length; si++) {
    const sheet = sheets[si];
    const maxRow = Number(sheet.rowCount ?? 0), maxColumn = Number(sheet.columnCount ?? 0);
    const rows = [], candidates = [];
    let cellsInSheet = 0, formulas = 0, hidden = 0, extraColumns = false;
    const rowLimit = Math.min(maxRow, LIMITS.rowsPerSheet);
    const colLimit = Math.min(maxColumn, LIMITS.columnsPerSheet);
    for (let rn = 1; rn <= rowLimit; rn++) {
      const row = sheet.getRow(rn), cells = [];
      row.eachCell({ includeEmpty: false }, cell => {
        if (cell.col > LIMITS.columnsPerSheet) { extraColumns = true; return; }
        cells.push(snapshotCell(cell));
      });
      if (!cells.length) continue;
      const hasFormula = cells.some(cell => Boolean(cell.formula));
      formulas += cells.filter(cell => Boolean(cell.formula)).length;
      cellsInSheet += cells.length; totalCells += cells.length; totalRows++;
      if (row.hidden) hidden++;
      rows.push({ rn, hidden: Boolean(row.hidden), cells, hasFormula });
      if (totalRows > LIMITS.totalRows || totalCells > LIMITS.totalCells) {
        throw new Error('تجاوز الملف حدود الاستقبال الآمن. لم تُحفظ دفعة جزئية ولم تُعدّل البيانات المعتمدة.');
      }
    }
    for (let rn = 1; rn <= Math.min(rowLimit, LIMITS.headerRows); rn++) {
      const labels = [];
      for (let col = 1; col <= colLimit; col++) labels.push(plainText(sheet.getRow(rn).getCell(col).value));
      const mapping = mapHeaderRow(labels);
      const nonemptyHeaders = labels.map(value => String(value ?? '').trim()).filter(Boolean);
      const normalizedHeaders = nonemptyHeaders.map(normalizeLabel);
      const distinctHeaders = new Set(normalizedHeaders);
      const hasDataBelow = [rn + 1, rn + 2, rn + 3].some((sampleRow) => {
        if (sampleRow > rowLimit) return false;
        let populated = 0;
        sheet.getRow(sampleRow).eachCell({ includeEmpty: false }, () => { populated += 1; });
        return populated >= 2;
      });
      // Keep non-ministry datasets discoverable without guessing their schema:
      // three or more distinct textual headers plus actual tabular data are a
      // review candidate, never an automatic import decision.
      const genericHeaderCandidate = mapping.matched.length < 2
        && nonemptyHeaders.length >= 3
        && nonemptyHeaders.length <= 40
        && distinctHeaders.size >= 3
        && nonemptyHeaders.every(value => value.length <= 100)
        && hasDataBelow;
      if (mapping.matched.length < 2 && !genericHeaderCandidate) continue;
      const keys = mapping.matched.map(item => item.key);
      const normalizedText = normalizedHeaders.join(' ');
      const isDirectorate = keys.includes('districtName') && keys.includes('governorate');
      const projectHints = ['اسم المشروع', 'المشروع', 'تكلفه المشروع', 'تكلفه تقديريه', 'حاله المشروع', 'رقم المشروع', 'رمز المشروع'];
      const indicatorHints = ['اسم المؤشر', 'المؤشر', 'القيمه', 'الفتره', 'السنه', 'نتيجه المؤشر'];
      const candidateType = isDirectorate ? 'directorate-candidate'
        : projectHints.some(hint => normalizedText.includes(normalizeLabel(hint))) ? 'project-candidate'
          : indicatorHints.some(hint => normalizedText.includes(normalizeLabel(hint))) ? 'indicator-candidate'
            : 'unclassified';
      const confidence = mapping.matched.length
        ? mapping.matched.reduce((sum,item) => sum + Number(item.score ?? 0),0) / mapping.matched.length
        : Math.min(0.8, 0.35 + nonemptyHeaders.length / 100);
      candidates.push({ headerRow: rn, matched: mapping.matched, unmatched: mapping.unmatched,
        duplicates: mapping.duplicates, candidateType, confidence });
    }
    const regions = candidates.map((candidate, index) => ({ ...candidate, regionIndex: index + 1,
      firstDataRow: candidate.headerRow + 1,
      lastDataRow: candidates[index + 1] ? candidates[index + 1].headerRow - 1 : rowLimit }));
    const merges = sheet.model?.merges ?? sheet._merges ?? [];
    const merged = Array.isArray(merges) ? merges.map(String) : Object.keys(merges).map(String);
    const tables = Object.entries(sheet.tables ?? {}).map(([key,table]) => ({ name: table?.name ?? table?.model?.name ?? key, ref: table?.ref ?? table?.model?.ref ?? null }));
    const anchors = anchorsFor(sheet, mediaAll);
    const sheetTruncated = maxRow > LIMITS.rowsPerSheet || maxColumn > LIMITS.columnsPerSheet || extraColumns;
    truncated ||= sheetTruncated; formulaCount += formulas; hiddenRowCount += hidden;
    inventory.push({ sheet, si, maxRow, maxColumn, rowLimit, rows, regions, merged, tables, anchors,
      cellsInSheet, formulas, hidden, truncated: sheetTruncated });
  }

  const anchorIndex = new Map();
  for (const item of inventory) for (const a of item.anchors) if (a.mediaIndex !== null) {
    const list = anchorIndex.get(a.mediaIndex) ?? [];
    list.push({ sheetName: item.sheet.name, ...a }); anchorIndex.set(a.mediaIndex, list);
  }

  const now = new Date().toISOString();
  const write = database.transaction(() => {
    const batch = database.prepare("INSERT INTO workbook_import_batches (file_name,file_size,sha256,original_file,sheet_count,row_count,cell_count,media_count,truncated,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'staged',?,?)")
      .run(path.basename(filePath), stat.size, sha, original, sheets.length, totalRows, totalCells, mediaAll.length, truncated ? 1 : 0, now, now);
    const batchId = Number(batch.lastInsertRowid);
    const source = database.prepare("INSERT INTO data_sources (source_type,document_title,file_name,mime_type,content_sha256,file_size,received_at,notes) VALUES ('excel-workbook',?,?,?, ?,?,?,?)")
      .run(path.basename(filePath), path.basename(filePath), path.extname(filePath).toLowerCase() === '.xlsm'
        ? 'application/vnd.ms-excel.sheet.macroEnabled.12' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sha, stat.size, now, 'نسخة المصدر الأصلية محفوظة داخل قاعدة البيانات المحلية المشفّرة.');
    database.prepare("UPDATE workbook_import_batches SET source_id=? WHERE id=?").run(Number(source.lastInsertRowid), batchId);

    const sheetIds = new Map();
    const addSheet = database.prepare("INSERT INTO workbook_import_sheets (batch_id,worksheet_id,sheet_index,name,state,max_row,max_column,scanned_rows,nonempty_row_count,cell_count,formula_count,hidden_row_count,merged_ranges_json,tables_json,image_count,anchor_count,truncated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const addRegion = database.prepare("INSERT INTO workbook_import_regions (batch_id,sheet_id,region_index,header_row,first_data_row,last_data_row,candidate_type,match_count,confidence,mapping_json) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const addRow = database.prepare("INSERT INTO workbook_import_rows (batch_id,sheet_id,row_number,is_hidden,cell_count,has_formula,cells_json,content_sha256) VALUES (?,?,?,?,?,?,?,?)");
    for (const item of inventory) {
      const r = addSheet.run(batchId, item.sheet.id, item.si + 1, item.sheet.name, item.sheet.state ?? 'visible',
        item.maxRow, item.maxColumn, item.rowLimit, item.rows.length, item.cellsInSheet, item.formulas, item.hidden,
        json(item.merged), json(item.tables), item.anchors.length, item.anchors.length, item.truncated ? 1 : 0);
      const sheetId = Number(r.lastInsertRowid); sheetIds.set(item.sheet.name, sheetId);
      for (const region of item.regions) addRegion.run(batchId, sheetId, region.regionIndex, region.headerRow,
        region.firstDataRow, Math.max(region.firstDataRow - 1, region.lastDataRow), region.candidateType,
        region.matched.length, region.confidence, json({ matched: region.matched, unmatched: region.unmatched, duplicates: region.duplicates }));
      for (const row of item.rows) {
        const data = json(row.cells);
        addRow.run(batchId, sheetId, row.rn, row.hidden ? 1 : 0, row.cells.length, row.hasFormula ? 1 : 0,
          data, crypto.createHash('sha256').update(data).digest('hex'));
      }
    }

    let mediaStored = 0, storedBytes = 0;
    const addMedia = database.prepare("INSERT INTO workbook_import_media (batch_id,sheet_id,media_index,original_name,extension,mime_type,size_bytes,sha256,content,anchors_json,extraction_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    mediaAll.forEach((item,index) => {
      const buffer = Buffer.isBuffer(item.buffer) ? item.buffer : item.buffer instanceof Uint8Array ? Buffer.from(item.buffer)
        : typeof item.base64 === 'string' ? Buffer.from(item.base64.includes(',') ? item.base64.split(',').pop() : item.base64,'base64') : null;
      const bytes = buffer?.length ?? 0;
      const anchors = anchorIndex.get(item.index) ?? [];
      const sheetId = anchors[0] ? sheetIds.get(anchors[0].sheetName) ?? null : null;
      let status = buffer ? 'stored' : 'bytes-unavailable', data = buffer;
      if (bytes > LIMITS.mediaItemBytes || storedBytes + bytes > LIMITS.mediaTotalBytes) { status = 'size-limit-exceeded'; data = null; }
      else if (buffer) { mediaStored++; storedBytes += bytes; }
      else data = null;
      const ext = String(item.extension ?? '').toLowerCase();
      addMedia.run(batchId, sheetId, Number(item.index ?? index), String(item.name ?? ('image-' + (index + 1))), ext,
        ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',svg:'image/svg+xml',webp:'image/webp'})[ext] ?? 'application/octet-stream',
        bytes, data ? crypto.createHash('sha256').update(data).digest('hex') : null, data, json(anchors), status);
    });
    database.prepare("UPDATE workbook_import_batches SET media_stored_count=? WHERE id=?").run(mediaStored, batchId);
    return { batchId, mediaStored };
  });
  const saved = write();
  return {
    batchId: saved.batchId,
    fileName: path.basename(filePath),
    fileSize: stat.size,
    sha256: sha,
    sheetCount: sheets.length,
    rowCount: totalRows,
    cellCount: totalCells,
    formulaCount,
    hiddenRowCount,
    mediaCount: mediaAll.length,
    mediaStoredCount: saved.mediaStored,
    mediaUnanchoredCount: mediaAll.filter(item => !(anchorIndex.get(item.index)?.length)).length,
    truncated,
    status: 'staged',
    limits: LIMITS,
    sheets: database.prepare("SELECT id, sheet_index FROM workbook_import_sheets WHERE batch_id = ? ORDER BY sheet_index").all(saved.batchId).map((storedSheet, index) => ({
      id: storedSheet.id,
      index: storedSheet.sheet_index,
      ...(() => {
        const item = inventory[index];
        return {
      name: item.sheet.name,
      state: item.sheet.state ?? 'visible',
      rowCount: item.maxRow,
      columnCount: item.maxColumn,
      scannedRows: item.rowLimit,
      nonemptyRows: item.rows.length,
      cellCount: item.cellsInSheet,
      formulaCount: item.formulas,
      hiddenRowCount: item.hidden,
      imageCount: item.anchors.length,
      tableCount: item.tables.length,
      mergedRangeCount: item.merged.length,
      truncated: item.truncated,
      regions: item.regions.map(region => ({
        headerRow: region.headerRow,
        candidateType: region.candidateType,
        matchedCount: region.matched.length,
        confidence: region.confidence,
      })),
        };
      })(),
    })),
  };
}

function readWorkbookSheetPreview(database, batchId, sheetId, limit = 20) {
  const batch = Number(batchId);
  const sheet = Number(sheetId);
  const bounded = Math.min(30, Math.max(1, Number(limit) || 20));
  if (!Number.isSafeInteger(batch) || batch <= 0 || !Number.isSafeInteger(sheet) || sheet <= 0) {
    throw new Error('معرّف دفعة أو ورقة الاستيراد غير صالح.');
  }
  const metadata = database.prepare(
    'SELECT id, batch_id, sheet_index, name, state, nonempty_row_count FROM workbook_import_sheets WHERE id = ? AND batch_id = ?'
  ).get(sheet, batch);
  if (!metadata) throw new Error('الورقة المطلوبة لا تنتمي إلى دفعة الاستيراد المحددة.');
  const rows = database.prepare(
    'SELECT row_number, is_hidden, has_formula, cell_count, cells_json FROM workbook_import_rows WHERE batch_id = ? AND sheet_id = ? ORDER BY row_number LIMIT ?'
  ).all(batch, sheet, bounded).map(row => {
    const allCells = JSON.parse(row.cells_json);
    return {
      rowNumber: row.row_number,
      hidden: Boolean(row.is_hidden),
      hasFormula: Boolean(row.has_formula),
      cellCount: row.cell_count,
      cells: allCells.slice(0, 24),
      cellsTruncated: allCells.length > 24,
    };
  });
  return { batchId: batch, sheet: metadata, rows, limit: bounded, truncated: rows.length < metadata.nonempty_row_count };
}

function completeWorkbookImport(database, batchId, result = {}) {
  const id = Number(batchId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('معرّف دفعة الاستيراد غير صالح.');
  const applied = Number(result.applied ?? 0);
  const status = applied > 0
    ? (Number(result.refused?.length ?? 0) || Number(result.skipped?.length ?? 0) ? 'directorates-partially-applied' : 'directorates-applied')
    : 'reviewed-without-directorate-write';
  database.prepare("UPDATE workbook_import_batches SET status=?,result_json=?,updated_at=? WHERE id=?")
    .run(status, json(result), new Date().toISOString(), id);
  return { batchId: id, status };
}

function listWorkbookImports(database, limit = 30) {
  const bounded = Math.min(100, Math.max(1, Number(limit) || 30));
  return database.prepare("SELECT b.id,b.file_name,b.file_size,b.sha256,b.sheet_count,b.row_count,b.cell_count,b.media_count,b.media_stored_count,b.truncated,b.status,b.created_at,b.updated_at,(SELECT COUNT(*) FROM workbook_import_regions r WHERE r.batch_id=b.id) AS region_count,(SELECT COUNT(*) FROM workbook_import_rows w WHERE w.batch_id=b.id) AS stored_row_count FROM workbook_import_batches b ORDER BY b.id DESC LIMIT ?").all(bounded);
}

module.exports = { LIMITS, migrateCanonicalData, stageWorkbook, readWorkbookSheetPreview, completeWorkbookImport, listWorkbookImports };
