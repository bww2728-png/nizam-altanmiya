'use strict';

const path = require('node:path');
const ExcelJS = require('exceljs');
const { FIELD_BY_KEY, INPUT_FIELDS, DECISION_FIELD } = require('./schema.cjs');
const { mapHeaderRow } = require('./mapping.cjs');
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
const MAX_COLUMNS = 400;
const HEADER_SCAN_ROWS = 200;
const INVENTORY_ROW_LIMIT = 5000;

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

function maxColumnIndex(worksheet) {
  // ExcelJS columnCount is the highest populated column index; actualColumnCount
  // is only a count of non-empty columns and can truncate sparse worksheets.
  return Math.min(worksheet.columnCount || worksheet.actualColumnCount || 80, MAX_COLUMNS);
}

/** Candidate header rows are evidence only; each remains a separate review region. */
function detectHeaderCandidates(worksheet, maxColumn = maxColumnIndex(worksheet)) {
  const lastHeaderRow = Math.min(worksheet.rowCount || 0, HEADER_SCAN_ROWS);
  const candidates = [];

  for (let rowNumber = 1; rowNumber <= lastHeaderRow; rowNumber += 1) {
    const cells = rowCells(worksheet, rowNumber, maxColumn);
    const mapping = mapHeaderRow(cells);
    const matchedKeys = mapping.matched.map((item) => item.key);
    // A directorate identity plus at least one other recognised field reduces
    // accidental matches against titles, notes and ordinary data rows.
    if (!mapping.columnMap.districtName || matchedKeys.length < 2) continue;
    candidates.push({
      headerRow: rowNumber,
      score: mapping.matched.length,
      matchedCount: mapping.matched.length,
      matchedKeys,
      matched: mapping.matched,
      unmatchedCount: mapping.unmatched.length,
      duplicates: mapping.duplicates,
    });
  }
  return candidates;
}

function detect(worksheet) {
  const maxColumn = maxColumnIndex(worksheet);
  const candidates = detectHeaderCandidates(worksheet, maxColumn);
  const best = candidates.reduce((current, candidate) => (
    !current || candidate.score > current.score ? candidate : current
  ), null);
  if (!best) return { headerRow: 0, score: 0, maxColumn, candidates };
  return { ...best, maxColumn, candidates };
}

function safeWorksheetInventory(worksheet, detection, selectedSheetName, workbookImageAssetCount = 0) {
  const rowLimit = Math.min(worksheet.rowCount || 0, INVENTORY_ROW_LIMIT);
  let formulaCount = 0;
  let hiddenRowCount = 0;

  for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (row.hidden) hiddenRowCount += 1;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell.value;
      if (value && typeof value === 'object' && (value.formula || value.sharedFormula)) formulaCount += 1;
    });
  }

  const worksheetModel = worksheet.model ?? {};
  let anchoredImageCount = 0;
  try {
    const modelImages = (worksheetModel.media ?? []).filter((media) => media?.type === 'image' || media?.type === 'background');
    const apiImages = typeof worksheet.getImages === 'function' ? worksheet.getImages() : [];
    // Some MS Excel drawings are present in media but lack a usable sheet anchor.
    anchoredImageCount = Math.max(modelImages.length, apiImages.length);
  } catch { anchoredImageCount = 0; }

  let tableCount = 0;
  try {
    tableCount = typeof worksheet.getTables === 'function'
      ? worksheet.getTables().length
      : Object.keys(worksheet.tables ?? {}).length;
  } catch { tableCount = 0; }

  const merges = worksheetModel.merges ?? worksheet._merges ?? [];
  const mergedRangeCount = Array.isArray(merges) ? merges.length : Object.keys(merges).length;

  const state = worksheet.state || 'visible';
  return {
    name: worksheet.name,
    state,
    hidden: state !== 'visible',
    selected: worksheet.name === selectedSheetName,
    rowCount: worksheet.rowCount || 0,
    populatedRowCount: worksheet.actualRowCount || 0,
    columnCount: worksheet.columnCount || 0,
    populatedColumnCount: worksheet.actualColumnCount || 0,
    inspectedRowCount: rowLimit,
    inventoryTruncated: (worksheet.rowCount || 0) > rowLimit,
    headerScanTruncated: (worksheet.rowCount || 0) > HEADER_SCAN_ROWS,
    headerCandidates: (detection.candidates ?? []).map((item) => ({
      headerRow: item.headerRow,
      matchedCount: item.matchedCount,
      matchedKeys: item.matchedKeys,
      unmatchedCount: item.unmatchedCount,
      duplicateHeaderCount: item.duplicates.length,
    })),
    formulaCount,
    hiddenRowCount,
    imageCount: anchoredImageCount,
    anchoredImageCount,
    workbookImageAssetCount,
    tableCount,
    mergedRangeCount,
  };
}

/**
 * @returns {Promise<{sheetName:string, headerRow:number, firstDataRow:number, columnMap:object,
 *   matched:Array, unmatched:Array, duplicates:Array, rows:Array, warnings:Array, totalRows:number}>}
 */
async function readDirectorateWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const analyses = workbook.worksheets.map((worksheet) => ({
    worksheet,
    detection: detect(worksheet),
  }));
  const isVisibleSheet = (worksheet) => (worksheet.state || 'visible') === 'visible';
  const visibleCandidates = analyses.filter((item) => isVisibleSheet(item.worksheet) && item.detection.headerRow);
  const hiddenCandidates = analyses.filter((item) => !isVisibleSheet(item.worksheet) && item.detection.headerRow);
  const chosen = visibleCandidates.reduce((best, item) => (
    !best || item.detection.score > best.detection.score ? item : best
  ), null);

  if (!chosen) {
    const hiddenNames = hiddenCandidates.map((item) => item.worksheet.name);
    if (hiddenNames.length) {
      throw new Error(`لم يُعثر على جدول مديريات في الأوراق الظاهرة. وُجدت رؤوس محتملة في أوراق مخفية: ${hiddenNames.join('، ')}. أظهر الورقة وراجعها قبل الاستيراد.`);
    }
    throw new Error('لم يُعثر على ورقة ظاهرة تحتوي رؤوس أعمدة معرّفة للمديريات.');
  }

  const { worksheet, detection } = chosen;
  // Workbook-level media assets are counted separately from sheet anchors.
  // ExcelJS 4.4.0 has reports of getImages() missing some MS Excel drawings;
  // preserve unanchored media as unassigned instead of guessing their row.
  const workbookMedia = workbook.model?.media ?? [];
  const workbookImageAssetCount = workbookMedia.filter((media) => media?.type === 'image' || media?.type === 'background').length;
  const sheetInventories = analyses.map((item) => (
    safeWorksheetInventory(item.worksheet, item.detection, worksheet.name, workbookImageAssetCount)
  ));
  const anchoredImageCount = sheetInventories.reduce((sum, item) => sum + item.anchoredImageCount, 0);
  const workbookInventory = {
    sheetCount: workbook.worksheets.length,
    visibleSheetCount: analyses.filter((item) => isVisibleSheet(item.worksheet)).length,
    hiddenSheetCount: analyses.filter((item) => !isVisibleSheet(item.worksheet)).length,
    selectedSheet: worksheet.name,
    selectedHeaderRow: detection.headerRow,
    headerScanLimit: HEADER_SCAN_ROWS,
    workbookImageAssetCount,
    anchoredImageCount,
    unanchoredImageAssetCount: Math.max(0, workbookImageAssetCount - anchoredImageCount),
    sheets: sheetInventories,
  };
  const headerCells = rowCells(worksheet, detection.headerRow, detection.maxColumn);
  const mapping = mapHeaderRow(headerCells);
  const columnMap = mapping.columnMap;

  if (!columnMap.districtName) {
    throw new Error(`الورقة «${worksheet.name}» لا تحتوي عمود «اسم المديرية»؛ لا يمكن بناء سجلات مديريات.`);
  }

  const warnings = [];
  const rows = [];

  const unselectedSheets = analyses.filter((item) => item.worksheet.name !== worksheet.name && isVisibleSheet(item.worksheet) && item.detection.headerRow);
  if (unselectedSheets.length) {
    warnings.push({
      row: null,
      code: 'unimported-data-sheets',
      message: `عُثر على ${unselectedSheets.length} ورقة أخرى تحتوي رؤوس بيانات محتملة ولم تُستورد في هذه العملية: ${unselectedSheets.map((item) => item.worksheet.name).join('، ')}.`,
    });
  }
  if (hiddenCandidates.length) {
    warnings.push({
      row: null,
      code: 'hidden-data-sheets',
      message: `توجد أوراق مخفية تحتوي رؤوسًا محتملة ولم تُفتح تلقائيًا: ${hiddenCandidates.map((item) => item.worksheet.name).join('، ')}.`,
    });
  }
  const additionalRegions = (detection.candidates ?? []).filter((item) => item.headerRow !== detection.headerRow);
  if (additionalRegions.length) {
    warnings.push({
      row: null,
      code: 'unimported-table-regions',
      message: `عُثر على ${additionalRegions.length} رأس جدول إضافي في الورقة «${worksheet.name}» عند الصفوف ${additionalRegions.map((item) => item.headerRow).join('، ')}. استُخدم الجدول الأول فقط؛ ولم تُدمج المناطق الأخرى تلقائيًا.`,
    });
  }
  if (workbookInventory.workbookImageAssetCount > 0) {
    warnings.push({
      row: null,
      code: 'embedded-images-detected',
      message: `عُثر على ${workbookInventory.workbookImageAssetCount} أصل صورة في الملف؛ أمكن تحديد موضع ${workbookInventory.anchoredImageCount} منها عبر مراجع الأوراق، وبقي ${workbookInventory.unanchoredImageAssetCount} بلا موضع موثوق. لم تُربط الصور بالمديريات تلقائيًا.`,
    });
  }
  if (workbookInventory.sheets.some((item) => item.formulaCount > 0)) {
    warnings.push({ row: null, code: 'formula-cells-detected', message: 'يحتوي الملف على خلايا صيغ. لم تُنفّذ أي صيغة؛ تُقرأ النتيجة المحفوظة فقط عند توفرها.' });
  }
  if (workbookInventory.sheets.some((item) => item.mergedRangeCount > 0)) {
    warnings.push({ row: null, code: 'merged-cells-detected', message: 'توجد خلايا مدمجة في الملف؛ يلزم مراجعة مناطقها قبل تفسير الجداول المتأثرة.' });
  }
  if (workbookInventory.sheets.some((item) => item.inventoryTruncated)) {
    warnings.push({ row: null, code: 'inventory-row-limit', message: `اقتصر حصر الصيغ والصفوف المخفية على أول ${INVENTORY_ROW_LIMIT} صفًا في الورقة؛ لم تُفحص بقية الصفوف لهذه العناصر.` });
  }
  if (workbookInventory.sheets.some((item) => item.headerScanTruncated)) {
    warnings.push({ row: null, code: 'header-scan-limit', message: `اقتصر اكتشاف رؤوس الجداول على أول ${HEADER_SCAN_ROWS} صفًا من كل ورقة.` });
  }

  const nextHeader = (additionalRegions
    .map((candidate) => candidate.headerRow)
    .filter((rowNumber) => rowNumber > detection.headerRow)
    .sort((a, b) => a - b)[0]) ?? null;
  const lastRow = Math.min(
    worksheet.rowCount || 0,
    detection.headerRow + MAX_ROWS,
    nextHeader ? nextHeader - 1 : Number.POSITIVE_INFINITY
  );

  for (let rowNumber = detection.headerRow + 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = {};
    const rawValues = {};
    const sources = {};
    const rowWarnings = [];
    if (row.hidden) {
      rowWarnings.push({ key: null, code: 'hidden-row', raw: '', value: null });
    }
    let hasAnyValue = false;

    for (const [key, column] of Object.entries(columnMap)) {
      const field = FIELD_BY_KEY[key] ?? (key === DECISION_FIELD.key ? DECISION_FIELD : null);
      if (!field) continue;
      const cell = row.getCell(column);
      const raw = cell.value === undefined || cell.value === null ? null : cell.value;
      const text = cellText(raw);
      const isFormula = Boolean(raw && typeof raw === 'object' && (raw.formula || raw.sharedFormula));
      const formulaText = isFormula ? `=${raw.formula ?? raw.sharedFormula}` : '';
      if (text !== '' || isFormula) hasAnyValue = true;
      const parsed = parseFieldValue(raw === null ? null : (typeof raw === 'object' && raw.result !== undefined ? raw.result : raw), field);
      if (isFormula) {
        rowWarnings.push({ key, code: 'formula-cell', raw: formulaText, value: parsed.value });
      }
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
      // The parser records the exact rejection reason itself (`invalid-*`, or
      // `ratio-out-of-range` for a percentage above 100), so no synthetic code is
      // added here — otherwise one bad value would carry two blockers and every
      // quality check would count it twice.
    }

    if (!hasAnyValue) continue;

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
    workbookInventory,
  };
}

module.exports = {
  readDirectorateWorkbook,
  cellText,
  detect,
  detectHeaderCandidates,
  safeWorksheetInventory,
  detectRowCells: rowCells,
};