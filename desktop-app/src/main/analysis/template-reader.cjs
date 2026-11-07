'use strict';

const path = require('node:path');
const ExcelJS = require('exceljs');
const { FIELD_BY_KEY, INPUT_FIELDS, DECISION_FIELD } = require('./schema.cjs');
const { mapHeaderRow, scoreHeaderRow } = require('./mapping.cjs');
const { parseFieldValue } = require('./parse.cjs');

/**
 * Reads a directorate-level workbook (the 67-column «قاعدة البيانات الشاملة»).
 *
 * Differences from the generic importer:
 *  - detects the header row instead of assuming row 1 (the real workbook uses
 *    two header rows: groups then field names);
 *  - maps columns to canonical fields by meaning, not by position;
 *  - parses values into typed numbers and records every conversion;
 *  - keeps the exact cell address of every value as provenance.
 */

const MAX_ROWS = 5000;
const HEADER_SCAN_ROWS = 4;
const EMPTY_RUN_LIMIT = 20;

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('').trim();
    if (value.text !== undefined) return String(value.text).trim();
    if (value.result !== undefined) return String(value.result).trim();
    if (value.formula !== undefined) return '';
    if (value.hyperlink) return String(value.text ?? value.hyperlink).trim();
    if (value instanceof Date) return value.toISOString();
    return '';
  }
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function rowCells(worksheet, rowNumber, maxColumn) {
  const cells = [];
  const row = worksheet.getRow(rowNumber);
  for (let column = 1; column <= maxColumn; column += 1) cells.push(cellText(row.getCell(column).value));
  return cells;
}

function detect(worksheet) {
  const maxColumn = Math.min(worksheet.actualColumnCount || worksheet.columnCount || 80, 400);
  let best = { headerRow: 0, score: 0, maxColumn };

  for (let rowNumber = 1; rowNumber <= HEADER_SCAN_ROWS; rowNumber += 1) {
    const cells = rowCells(worksheet, rowNumber, maxColumn);
    const score = scoreHeaderRow(cells);
    if (score > best.score) best = { headerRow: rowNumber, score, maxColumn };
  }

  if (!best.headerRow) {
    return { headerRow: 0, score: 0, maxColumn };
  }

  return best;
}

/**
 * @returns {Promise<{sheetName:string, headerRow:number, firstDataRow:number, columnMap:object,
 *   matched:Array, unmatched:Array, duplicates:Array, rows:Array, warnings:Array, totalRows:number}>}
 */
async function readDirectorateWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  let chosen = null;
  for (const worksheet of workbook.worksheets) {
    const detection = detect(worksheet);
    if (!detection.headerRow) continue;
    if (!chosen || detection.score > chosen.detection.score) chosen = { worksheet, detection };
  }

  if (!chosen) {
    throw new Error('لم يُعثر على ورقة تحتوي رؤوس أعمدة مفهومة (قاعدة البيانات الشاملة).');
  }

  const { worksheet, detection } = chosen;
  const headerCells = rowCells(worksheet, detection.headerRow, detection.maxColumn);
  const mapping = mapHeaderRow(headerCells);
  const columnMap = mapping.columnMap;

  if (!columnMap.districtName) {
    throw new Error(`الورقة «${worksheet.name}» لا تحتوي عمود «اسم المديرية»؛ لا يمكن بناء سجلات مديريات.`);
  }

  const warnings = [];
  const rows = [];
  let emptyRun = 0;
  const lastRow = Math.min(worksheet.actualRowCount || worksheet.rowCount || 0, detection.headerRow + MAX_ROWS);

  for (let rowNumber = detection.headerRow + 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = {};
    const rawValues = {};
    const sources = {};
    const rowWarnings = [];
    let hasAnyValue = false;

    for (const [key, column] of Object.entries(columnMap)) {
      const field = FIELD_BY_KEY[key] ?? (key === DECISION_FIELD.key ? DECISION_FIELD : null);
      if (!field) continue;
      const cell = row.getCell(column);
      const raw = cell.value === undefined || cell.value === null ? null : cell.value;
      const text = cellText(raw);
      if (text !== '') hasAnyValue = true;
      const parsed = parseFieldValue(raw === null ? null : (typeof raw === 'object' && raw.result !== undefined ? raw.result : raw), field);
      // Only a value that parsed cleanly may touch the database. An empty or
      // placeholder cell must NOT arrive as an explicit `null`, otherwise
      // re-importing a partial workbook would silently wipe values that were
      // entered manually or came from an earlier, fuller file. Clearing a value
      // is an explicit action on the manual-entry screen, not a side effect of
      // an empty Excel cell.
      if (parsed.state === 'ok') {
        values[key] = parsed.value;
        sources[key] = cell.address;
      }
      rawValues[key] = text;
      for (const warning of parsed.warnings) {
        rowWarnings.push({ key, code: warning.code, raw: text, value: parsed.value });
      }
      if (parsed.state === 'invalid' && text !== '') {
        rowWarnings.push({ key, code: `invalid-${field.type}`, raw: text, value: null });
      }
    }

    if (!hasAnyValue) {
      emptyRun += 1;
      if (emptyRun >= EMPTY_RUN_LIMIT) break;
      continue;
    }
    emptyRun = 0;

    const districtName = values.districtName ?? rawValues.districtName ?? '';
    if (!districtName) {
      warnings.push({ row: rowNumber, code: 'row-without-name', message: `الصف ${rowNumber} يحتوي بيانات بلا اسم مديرية.` });
      continue;
    }
    values.districtName = districtName;

    rows.push({
      id: `template:${rowNumber}`,
      rowNumber,
      districtName,
      governorate: values.governorate ?? '',
      values,
      rawValues,
      sources,
      warnings: rowWarnings,
    });
  }

  const matchedKeys = new Set(Object.keys(columnMap));
  const missingInputs = INPUT_FIELDS.filter((field) => !matchedKeys.has(field.key)).map((field) => ({
    key: field.key, column: field.column, header: field.header,
  }));

  if (mapping.duplicates.length) warnings.push({ row: null, code: 'duplicate-headers', message: `أعمدة مكرّرة الدلالة: ${mapping.duplicates.length}.` });

  return {
    fileName: path.basename(filePath),
    sheetName: worksheet.name,
    headerRow: detection.headerRow,
    firstDataRow: detection.headerRow + 1,
    columnMap,
    matched: mapping.matched,
    unmatched: mapping.unmatched,
    duplicates: mapping.duplicates,
    missingInputs,
    rows,
    warnings,
    totalRows: rows.length,
  };
}

module.exports = { readDirectorateWorkbook, cellText, detectRowCells: rowCells };