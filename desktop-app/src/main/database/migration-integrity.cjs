'use strict';

/**
 * Line-ending safe migration checksums and drift reporting.
 *
 * Why this exists: the packaged installers are built on a Windows runner whose
 * git checkout uses CRLF line endings, while development checkouts use LF. The
 * schema text used to be hashed as raw bytes, so the *same* migration produced
 * two different sha256 digests depending on where it was built. A store that
 * recorded the CRLF digest then refused to open under an LF build (and the other
 * way round) with «تم تعديل الترحيل بعد تطبيقه», which locked the installed
 * application out of its own database even though the migration body was byte
 * identical.
 *
 * Rules implemented here:
 *
 *  1. `checksum()` is computed over the canonical (LF) document, so the digest
 *     is identical on every platform from now on.
 *  2. A recorded digest that equals the CRLF variant of the same document is
 *     accepted and reported as a line-ending variant.
 *  3. Any other difference is reported as drift, is written onto the migration
 *     row (never silently swallowed) and the caller keeps going, because every
 *     migration body guarded this way is idempotent and re-running it changes
 *     nothing. A user's database is never bricked by a checksum mismatch.
 */

const crypto = require('node:crypto');

/** Canonical form: no BOM, CRLF and lone CR folded to LF. */
function canonicalText(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Windows checkout form of the same document. */
function crlfText(text) {
  return canonicalText(text).replace(/\n/g, '\r\n');
}

function digest(text, definition, suffix) {
  const inner = crypto.createHash('sha256').update(String(text) + String(definition ?? '')).digest('hex');
  return suffix ? crypto.createHash('sha256').update(inner + String(suffix)).digest('hex') : inner;
}

/**
 * The digests a migration may legitimately have been recorded under.
 *
 * @param {{text:string, definition?:string, suffix?:string}} migration
 *   `text` is the schema/document body, `definition` is the JSON payload that is
 *   concatenated to it and `suffix` is the extra composite input used by
 *   migrations whose checksum is derived from another checksum.
 * @returns {{canonical:string, lineEndingVariant:string}}
 */
function migrationChecksums(migration) {
  const { text, definition = '', suffix = '' } = migration;
  return {
    canonical: digest(canonicalText(text), definition, suffix),
    lineEndingVariant: digest(crlfText(text), definition, suffix),
  };
}

/**
 * @returns {'verified'|'line-ending-variant'|'drift'} how a recorded checksum
 *   relates to the document currently on disk.
 */
function classifyRecordedChecksum(recorded, checksums) {
  if (recorded === checksums.canonical) return 'verified';
  if (recorded === checksums.lineEndingVariant) return 'line-ending-variant';
  return 'drift';
}

function driftNote(state, recorded, checksums) {
  return `checksum-${state}: applied=${recorded} current=${checksums.canonical}`;
}

/** Append the note to the migration row once; returns true when it was written. */
function recordChecksumDrift(db, table, version, note) {
  const row = db.prepare(`SELECT details FROM ${table} WHERE version=?`).get(version);
  const details = String(row?.details ?? '');
  if (details.includes(note)) return false;
  db.prepare(`UPDATE ${table} SET details=? WHERE version=?`).run(details ? `${details} | ${note}` : note, version);
  return true;
}

/**
 * Verify an already-applied migration row without ever throwing.
 *
 * @returns {{state:'verified'|'line-ending-variant'|'drift', recorded:boolean, note?:string}}
 */
function verifyAppliedMigration(db, options) {
  const { table, version, recorded, checksums, label } = options;
  const state = classifyRecordedChecksum(recorded, checksums);
  if (state === 'verified') return { state, recorded: false };
  const note = driftNote(state, recorded, checksums);
  const written = recordChecksumDrift(db, table, version, note);
  console.warn(`[migration] ${label ?? table} v${version}: ${note}`);
  return { state, recorded: written, note };
}

module.exports = {
  canonicalText,
  crlfText,
  migrationChecksums,
  classifyRecordedChecksum,
  driftNote,
  recordChecksumDrift,
  verifyAppliedMigration,
};