'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const { inspectXlsxPackage } = require('../src/main/analysis/xlsx-preflight.cjs');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? 0;
    const packed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const flags = entry.flags ?? 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + packed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const centralOffset = localOffset;
  const localBuffer = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuffer, centralBuffer, eocd]);
}

function minimalXlsxEntries(extra = []) {
  return [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: '<workbook/>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships/>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>' },
    ...extra,
  ];
}

function withTempFile(buffer, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-xlsx-preflight-'));
  const filePath = path.join(directory, 'workbook.xlsx');
  try {
    fs.writeFileSync(filePath, buffer);
    return callback(filePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('accepts a valid minimal XLSX ZIP package without extracting entries', () => {
  withTempFile(zipBuffer(minimalXlsxEntries()), (filePath) => {
    const result = inspectXlsxPackage(filePath);
    assert.equal(result.entryCount, 4);
    assert.equal(result.worksheetPartCount, 1);
    assert.ok(result.totalUncompressedBytes > 0);
  });
});

test('rejects a non-ZIP or truncated workbook package', () => {
  withTempFile(Buffer.from('not an Excel package'), (filePath) => {
    assert.throws(() => inspectXlsxPackage(filePath), /غير آمن أو تالف/);
  });
});

test('rejects a ZIP package without the required Excel parts', () => {
  withTempFile(zipBuffer([{ name: 'content.txt', data: 'hello' }]), (filePath) => {
    assert.throws(() => inspectXlsxPackage(filePath), /الأجزاء الأساسية/);
  });
});

test('rejects encrypted ZIP entries', () => {
  withTempFile(zipBuffer(minimalXlsxEntries([{ name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>', flags: 1 }])
    .filter((entry, index) => index !== 3)), (filePath) => {
    assert.throws(() => inspectXlsxPackage(filePath), /مشفّرة/);
  });
});

test('rejects path traversal entries before passing the package to ExcelJS', () => {
  withTempFile(zipBuffer(minimalXlsxEntries([{ name: '../outside.txt', data: 'no' }])), (filePath) => {
    assert.throws(() => inspectXlsxPackage(filePath), /انتقال خارج المجلد/);
  });
});

test('rejects a decompression-bomb-like entry using its central-directory size ratio', () => {
  const repeated = Buffer.alloc(4 * 1024 * 1024, 0x41);
  withTempFile(zipBuffer(minimalXlsxEntries([
    { name: 'xl/worksheets/sheet2.xml', data: repeated, method: 8 },
  ])), (filePath) => {
    assert.throws(
      () => inspectXlsxPackage(filePath, { maxCompressionRatio: 5 }),
      /نسبة ضغط مفرطة/
    );
  });
});

test('rejects a workbook whose expanded size exceeds the configured cap', () => {
  const data = Buffer.alloc(1024 * 1024, 0x42);
  withTempFile(zipBuffer(minimalXlsxEntries([
    { name: 'xl/worksheets/sheet2.xml', data },
  ])), (filePath) => {
    assert.throws(
      () => inspectXlsxPackage(filePath, { maxEntryUncompressedBytes: 512 * 1024 }),
      /يتجاوز حد الحجم/
    );
  });
});

test('rejects a package with an excessive number of entries', () => {
  const extra = Array.from({ length: 8 }, (_, index) => ({
    name: `custom/item-${index}.xml`,
    data: '<x/>',
  }));
  withTempFile(zipBuffer(minimalXlsxEntries(extra)), (filePath) => {
    assert.throws(() => inspectXlsxPackage(filePath, { maxEntries: 5 }), /عدد عناصر الحزمة/);
  });
});

