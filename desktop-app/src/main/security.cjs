'use strict';

/**
 * Data-access policy for the local store.
 *
 * The previous build *labelled* fields as `restricted`/`sensitive` in the
 * schema but never enforced the label: every value was returned by every IPC
 * channel and written into every export. Since the application has no user
 * accounts (by design, it is a single-operator desktop tool), a real
 * per-user permission model would be theatre. What is enforceable — and what
 * actually matters when the file or the exported report leaves this machine —
 * is a two-profile switch:
 *
 *   owner  : the person operating the machine; sees every field.
 *   shared : the machine/report is being used with someone else present or the
 *            export will be handed to a third party; restricted and sensitive
 *            values are masked in reads and omitted from exports, and every
 *            masked read is written to `audit_reads`.
 *
 * Masking is applied at the IPC boundary (never in SQL) so the stored data and
 * the analysis results remain complete and auditable.
 */

const { INPUT_FIELDS, DECISION_FIELD } = require('./analysis/schema.cjs');

const ACCESS_PROFILE_KEY = 'access.profile';
const PROFILES = ['owner', 'shared'];
const DEFAULT_PROFILE = 'owner';

/** Canonical keys whose sensitivity is not `public`, in schema order. */
const RESTRICTED_KEYS = INPUT_FIELDS.filter((field) => field.sensitivity === 'restricted').map((field) => field.key);
const SENSITIVE_KEYS = INPUT_FIELDS.filter((field) => field.sensitivity === 'sensitive').map((field) => field.key);
const PROTECTED_KEYS = [...RESTRICTED_KEYS, ...SENSITIVE_KEYS, DECISION_FIELD.key];
const PROTECTED_SET = new Set(PROTECTED_KEYS);

const PROFILE_LABELS = {
  owner: 'مالك الجهاز — كل الحقول مرئية',
  shared: 'وضع المشاركة — الحقول المقيّدة والحساسة محجوبة',
};

/** Normalise any input to a known profile name. */
function normalizeProfile(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return PROFILES.includes(text) ? text : DEFAULT_PROFILE;
}

function getAccessProfile(database) {
  try {
    const row = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(ACCESS_PROFILE_KEY);
    return normalizeProfile(row?.value);
  } catch {
    return DEFAULT_PROFILE;
  }
}

function setAccessProfile(database, profile) {
  const next = normalizeProfile(profile);
  database.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(ACCESS_PROFILE_KEY, next, new Date().toISOString());
  return next;
}

/** True when `key` must be masked under the given profile. */
function isProtected(key, profile) {
  return normalizeProfile(profile) === 'shared' && PROTECTED_SET.has(key);
}

/**
 * Mask protected values on a plain directorate record (column-keyed object).
 * Columns are the DB names, so the caller passes a key->column map or uses the
 * defaults derived from the schema.
 *
 * @returns {{ record:object, masked:string[] }}
 */
function maskRecord(record, profile, columnsByKey = null) {
  const masked = [];
  if (!record || normalizeProfile(profile) !== 'shared') return { record, masked };
  const output = { ...record };
  const mapping = columnsByKey ?? Object.fromEntries(INPUT_FIELDS.map((field) => [field.key, field.key]));
  for (const key of PROTECTED_KEYS) {
    const column = mapping[key] ?? key;
    if (!(column in output)) continue;
    if (output[column] === null || output[column] === undefined) continue;
    output[column] = null;
    masked.push(key);
  }
  return { record: output, masked };
}

/**
 * Mask the `values`/`rawValues` payload of an engine-shaped row.
 * @returns {{ row:object, masked:string[] }}
 */
function maskEngineRow(row, profile) {
  if (!row || normalizeProfile(profile) !== 'shared') return { row, masked: [] };
  const masked = [];
  const values = { ...(row.values ?? {}) };
  const rawValues = { ...(row.rawValues ?? {}) };
  for (const key of PROTECTED_KEYS) {
    if (values[key] === null || values[key] === undefined) continue;
    values[key] = null;
    rawValues[key] = '';
    masked.push(key);
  }
  return { row: { ...row, values, rawValues }, masked };
}

/** Field keys that must never appear in a third-party export under `shared`. */
function protectedKeysForExport(profile) {
  return normalizeProfile(profile) === 'shared' ? [...PROTECTED_KEYS] : [];
}

module.exports = {
  ACCESS_PROFILE_KEY,
  PROFILES,
  DEFAULT_PROFILE,
  PROFILE_LABELS,
  RESTRICTED_KEYS,
  SENSITIVE_KEYS,
  PROTECTED_KEYS,
  normalizeProfile,
  getAccessProfile,
  setAccessProfile,
  isProtected,
  maskRecord,
  maskEngineRow,
  protectedKeysForExport,
};