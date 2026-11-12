-- Additive schema hardening for the unified development model (v2).
-- Authority rule: existing tables/columns and records remain untouched; this file
-- only adds new objects. All statements are idempotent on their own.
--
-- NOTE: column additions (ALTER TABLE), guarded backfills, observation
-- uniqueness and sector hierarchy triggers live in
-- unified-development-model-v2.cjs because SQLite cannot conditionally run
-- ALTER TABLE ... ADD COLUMN. This file owns the currency registry only.

-- Currency registry: authoritative minor-unit source for exact money storage.
CREATE TABLE IF NOT EXISTS currencies (
  currency_code TEXT PRIMARY KEY,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  minor_unit INTEGER NOT NULL CHECK(minor_unit BETWEEN 0 AND 4),
  symbol TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_currencies_active ON currencies(is_active, currency_code);

INSERT OR IGNORE INTO currencies(currency_code,name_ar,name_en,minor_unit,symbol,is_active,created_at)
VALUES ('YER','ريال يمني','Yemeni Rial',2,'ر.ي',1,'2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO currencies(currency_code,name_ar,name_en,minor_unit,symbol,is_active,created_at)
VALUES ('USD','دولار أمريكي','US Dollar',2,'$',1,'2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO currencies(currency_code,name_ar,name_en,minor_unit,symbol,is_active,created_at)
VALUES ('SAR','ريال سعودي','Saudi Riyal',2,'ر.س',1,'2026-01-01T00:00:00.000Z');
