'use strict';

const fs = require('node:fs');

const LIMITS = Object.freeze({
  maxEntries: 20000,
  maxEntryUncompressedBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 1000,
  maxCentralDirectoryBytes: 32 * 1024 * 1024,
  maxFileNameBytes: 4096,
  maxExtraBytes: 65535,
  maxCommentBytes: 65535,
});
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_SEARCH_BYTES = EOCD_MIN_BYTES + 65535;

function fail(message) {
  throw new Error(`ملف Excel غير آمن أو تالف: ${message}`);
}

function readExactly(fd, length, position) {
  if (!Number.isSafeInteger(length) || length < 0) fail('طول قراءة غير صالح.');
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (read === 0) fail('نهاية غير متوقعة داخل حزمة ZIP.');
    offset += read;
  }
  return buffer;
}

function findEocd(tail, absoluteStart) {
  for (let offset = tail.length - EOCD_MIN_BYTES; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + EOCD_MIN_BYTES + commentLength !== tail.length) continue;
    return { offset, absoluteOffset: absoluteStart + offset, commentLength };
  }
  fail('لم يُعثر على سجل نهاية ZIP صالح.');
}

function decodeArchivePath(buffer) {
  const name = buffer.toString('utf8');
  if (!name || name.includes('\0')) fail('اسم عنصر فارغ أو يحوي محرفًا غير صالح.');
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) {
    fail('مسار مطلق داخل الحزمة غير مسموح.');
  }
  const segments = name.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) fail('مسار انتقال خارج المجلد داخل الحزمة.');
  return name;
}

/**
 * Inspect the ZIP central directory without extracting or inflating any entry.
 * XLSX/XLSM are ZIP packages; checking expanded sizes first reduces exposure to
 * decompression bombs before ExcelJS allocates workbook objects.
 */
function inspectXlsxPackage(filePath, overrides = {}) {
  const limits = { ...LIMITS, ...overrides };
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < EOCD_MIN_BYTES) fail('الحجم لا يشبه حزمة ZIP.');
  const fd = fs.openSync(filePath, 'r');

  try {
    const tailLength = Math.min(stat.size, EOCD_MAX_SEARCH_BYTES);
    const tailStart = stat.size - tailLength;
    const tail = readExactly(fd, tailLength, tailStart);
    const eocd = findEocd(tail, tailStart);
    const eocdPos = eocd.offset;

    const diskNumber = tail.readUInt16LE(eocdPos + 4);
    const centralDisk = tail.readUInt16LE(eocdPos + 6);
    const entriesOnDisk = tail.readUInt16LE(eocdPos + 8);
    const entryCount = tail.readUInt16LE(eocdPos + 10);
    const centralSize = tail.readUInt32LE(eocdPos + 12);
    const centralOffset = tail.readUInt32LE(eocdPos + 16);

    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
      fail('حزم ZIP متعددة الأقراص غير مدعومة.');
    }
    if (
      entryCount === 0xffff
      || centralSize === 0xffffffff
      || centralOffset === 0xffffffff
    ) {
      fail('امتدادات ZIP64 غير مدعومة في هذا الإصدار؛ استخدم ملف XLSX عاديًا.');
    }
    if (entryCount === 0 || entryCount > limits.maxEntries) {
      fail(`عدد عناصر الحزمة غير مقبول (${entryCount}).`);
    }
    if (centralSize > limits.maxCentralDirectoryBytes) {
      fail('فهرس ZIP المركزي يتجاوز الحد الآمن.');
    }
    if (centralOffset + centralSize > eocd.absoluteOffset) {
      fail('حدود فهرس ZIP المركزي غير متناسقة.');
    }
    if (centralOffset + centralSize !== eocd.absoluteOffset) {
      fail('توجد فجوة أو بيانات غير متوقعة قبل نهاية حزمة ZIP.');
    }

    const central = readExactly(fd, centralSize, centralOffset);
    const seen = new Set();
    const required = new Set([
      '[Content_Types].xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
    ]);
    const entries = [];
    let cursor = 0;
    let totalUncompressedBytes = 0;
    let imageAssetCount = 0;
    let worksheetPartCount = 0;
    let formulaRelatedPartCount = 0;

    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > central.length) fail('سجل عنصر ZIP المركزي مبتور.');
      if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        fail('توقيع عنصر ZIP مركزي غير صالح.');
      }

      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const fileNameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const startDisk = central.readUInt16LE(cursor + 34);
      const localOffset = central.readUInt32LE(cursor + 42);
      const recordLength = 46 + fileNameLength + extraLength + commentLength;

      if (cursor + recordLength > central.length) fail('بيانات اسم أو وصف عنصر ZIP مبتورة.');
      if (fileNameLength === 0 || fileNameLength > limits.maxFileNameBytes) {
        fail('طول اسم عنصر ZIP غير مقبول.');
      }
      if (extraLength > limits.maxExtraBytes || commentLength > limits.maxCommentBytes) {
        fail('بيانات وصف عنصر ZIP تتجاوز الحدود.');
      }
      if (startDisk !== 0) fail('العناصر الموزعة على أقراص متعددة غير مدعومة.');
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        fail('عنصر ZIP يستخدم ZIP64 غير مدعوم.');
      }
      if (flags & 0x0001) fail('ملفات Excel المشفّرة داخل ZIP غير مدعومة.');
      if (method !== 0 && method !== 8) fail(`طريقة ضغط ZIP غير مدعومة (${method}).`);

      const nameBuffer = central.subarray(cursor + 46, cursor + 46 + fileNameLength);
      const name = decodeArchivePath(nameBuffer);
      if (seen.has(name)) fail(`اسم عنصر مكرر داخل الحزمة: ${name}`);
      seen.add(name);

      if (uncompressedSize > limits.maxEntryUncompressedBytes) {
        fail(`العنصر ${name} يتجاوز حد الحجم بعد فك الضغط.`);
      }
      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
        fail('الحجم الإجمالي بعد فك الضغط يتجاوز الحد الآمن.');
      }
      if (uncompressedSize > 0) {
        if (compressedSize === 0) fail(`نسبة ضغط غير ممكنة في العنصر ${name}.`);
        const ratio = uncompressedSize / compressedSize;
        if (ratio > limits.maxCompressionRatio) {
          fail(`نسبة ضغط مفرطة في العنصر ${name}.`);
        }
      }

      if (name.startsWith('xl/media/') || name.startsWith('xl/drawings/')) imageAssetCount += 1;
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) worksheetPartCount += 1;
      if (name.startsWith('xl/calcChain')) formulaRelatedPartCount += 1;
      if (required.has(name)) required.delete(name);

      // Validate the corresponding local header and bounds without reading data.
      if (localOffset + 30 > centralOffset) fail(`رأس محلي غير صالح للعنصر ${name}.`);
      const localHeader = readExactly(fd, 30, localOffset);
      if (localHeader.readUInt32LE(0) !== LOCAL_SIGNATURE) {
        fail(`توقيع رأس محلي غير صالح للعنصر ${name}.`);
      }
      const localNameLength = localHeader.readUInt16LE(26);
      const localExtraLength = localHeader.readUInt16LE(28);
      if (localNameLength !== fileNameLength) fail(`طول اسم العنصر غير متطابق: ${name}.`);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > centralOffset) fail(`بيانات العنصر تتجاوز منطقة البيانات: ${name}.`);

      entries.push({ name, compressedSize, uncompressedSize, method });
      cursor += recordLength;
    }

    if (cursor !== central.length) fail('طول فهرس ZIP لا يطابق عدد العناصر.');
    if (required.size) fail(`حزمة Excel تفتقد الأجزاء الأساسية: ${[...required].join('، ')}.`);
    if (worksheetPartCount === 0) fail('لا تحتوي الحزمة على أي ورقة عمل Excel.');

    return {
      entryCount,
      totalCompressedBytes: entries.reduce((sum, entry) => sum + entry.compressedSize, 0),
      totalUncompressedBytes,
      imageAssetCount,
      worksheetPartCount,
      formulaRelatedPartCount,
      entries,
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { inspectXlsxPackage, LIMITS };
