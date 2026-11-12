# Canonical data model and Excel intake

## Purpose

This document records the additive data model introduced for the local-first desktop application and distinguishes what is already executable from the next domain-integration work. Excel is an input format, not the canonical database schema. The plain local SQLite database (unencrypted) remains the single source of truth for approved application data.

## Current implementation

### Existing analysis compatibility

The ranking and dashboard analysis now load approved directorate values from `entity_records` and `entity_field_values`; a compatibility bridge still syncs legacy imports and manual edits into that model and preserves the legacy IDs used by analysis history and exports. The current correction form and operational import plan still use legacy directorate persistence as the write-compatible interface. Historical observations whose reference period was never recorded remain explicitly marked as unspecified; migration does not invent dates or alter accepted analysis rules.

The new model is additive and idempotent. Canonical schema creation and legacy backfill run in one SQLite transaction, so a uniqueness or data-integrity failure rolls back the migration rather than leaving a partially created canonical model. Existing directorate values, analysis runs and audit history are not dropped or rewritten.

### Canonical relational schema

`canonical-data.cjs` creates these normalized tables:

- `geographic_units`: hierarchical geographic entities with parent links, optional official codes and validity dates.
- `sectors`: sector catalogue.
- `data_sources`: provenance for documents and imported source files.
- `data_field_definitions` and `data_field_aliases`: typed field metadata and approved aliases.
- `entity_records` and `entity_field_values`: extensible records with field values and a period key.
- `indicator_definitions` and `indicator_observations`: indicator definitions and dated, sourced observations.
- `projects` and `project_funding`: projects and their funding relationships.
- `managed_attachments`: binary attachments, SHA-256, source and review state.
- `data_quality_issues`: reviewable data quality findings.
- `workbook_import_batches`, `workbook_import_sheets`, `workbook_import_regions`, `workbook_import_rows` and `workbook_import_media`: durable intake of workbooks before data is promoted to approved entities.

The migration seeds current directorate fields and the current 12 indicator definitions into the metadata catalogue. It does not invent official geographic codes, sector classifications or temporal definitions.

## Workbook intake flow

The import IPC path now:

1. Validates the selected file using the existing XLSX ZIP preflight and file allowlist.
2. Attempts the legacy directorate-specific reader. If there is no suitable visible directorate table, it records that fact instead of coercing an unrelated sheet into directorate rows.
3. Saves the original workbook bytes and SHA-256 fingerprint in the local SQLite database.
4. Inventories every worksheet within documented bounds, including hidden state, dimensions, non-empty rows/cells, candidate headers, formula counts, hidden rows, merged ranges, Excel tables, media and image anchors where the library exposes them.
5. Stores each scanned non-empty row and cell with its address, row/column, cell type, raw representation, readable text, formula, cached result and note/comment when available.
6. Stores extractable embedded image bytes separately, with SHA-256 and anchor metadata if available. Assets without a trustworthy worksheet/row anchor remain unassigned.
7. Creates the existing directorate review plan separately. The legacy directorate importer still requires explicit user approval. Project-candidate regions have an owner-only mapping and row-approval path into canonical projects; indicator-candidate regions have a separate owner-only mapping and explicit row-approval path into dated canonical observations. Other regions remain staged and unapproved.
8. Updates the intake batch status after the directorate review action and displays a durable intake history.

Staging is transactional: if the file exceeds a scan cap before the write transaction begins, no partial staging batch is committed. The original source file is retained in the local database so the source package can be re-examined without relying on the original path.

The normalized import mirror carries mapping suggestions separately from the legacy staging record. Migration v3 adds target entity/field codes and persists explicit project- and indicator-column decisions with actor, timestamp and audit event when rows are promoted. Unselected columns remain unmapped; suggestions alone never authorize promotion. Approved directorate import plans likewise record accepted form-field mappings. This mirror is additive and idempotent, and can locate regions created by the earlier normalized region-code format.

## Project-region review and promotion

Project-like regions are now discovered from a conservative combination of recognizable project headers and non-empty tabular rows. Discovery is only a suggestion; it does not write into the canonical project tables.

In owner mode, the intake screen exposes each discovered project region, a bounded row preview and manual column mapping. The operator must review the suggested mapping, explicitly select row numbers and press the promotion action. Shared mode does not expose raw staged cell values or project promotion.

The promotion service currently handles project identity, description/status, estimated and actual costs, currency, ISO-like dates, optional geographic/sector references, and an optional funding partner/amount/currency. It refuses hidden rows, formula-bearing rows, invalid numeric/date values, duplicate project codes, and rows already promoted. It writes projects, funding, source references, row-to-entity promotion records, and unresolved geographic/sector quality issues in a database transaction. The original workbook, cell provenance, selected mapping and source row location remain traceable.

The project register supports owner-only manual create/update through the same main-process validation used for project fields: required identity, numeric and currency checks, date ordering, and reference validation. Each manual operation creates a data-source record; edits preserve a pre-change snapshot in `project_versions`. Funding can be added with its own amount/currency/date and provenance. A user-selected PDF, PNG, JPEG or WebP attachment is signature-checked, deduplicated by SHA-256, stored as a BLOB in the local database, and explicitly linked to the open project. The owner can export an attachment only through a save dialog; content length and SHA-256 are checked before writing, and the export is audited. Project-linked quality issues can be resolved with a required rationale and timestamp; the resolution is audited. Inline preview is not implemented.

Indicator-candidate regions can be explicitly mapped to a seeded indicator definition, canonical geographic unit, period, value and optional unit. Only individually approved rows with a unique indicator/geography/period key and a valid source mapping are promoted. Ambiguous geography, unknown indicators, hidden/formula-bearing rows, invalid values and duplicate observations remain unpromoted with a row-specific reason.

This remains a bounded entity-specific implementation, not a universal import engine. Generic entity regions, field-level tri-state promotion and user-managed dictionaries remain out of scope. Unmatched geography or sector text is recorded as a quality issue and is not converted into an invented reference. Workbook images are retained with available provenance, but semantic linking requires a separate explicit review path.

## Automatic update channel

The runtime keeps application data on the device: the SQLite store is a plain local file and no telemetry, analytics or cloud AI service is called. Application-level guards deny Node, Electron and renderer network requests except HTTPS GET requests to the configured GitHub Releases pages and GitHub release-asset hosts. The automatic updater checks `bww2728-png/nizam-altanmiya` for a version strictly higher than the installed one and installs a downloaded update on quit. `setupAutoUpdate()` in `src/main/main.cjs` performs the first check shortly after launch and repeats every six hours; the state is pushed to the renderer over `update:status`.

These guards cover the standard APIs patched in `offline-policy.cjs`, but cannot guarantee that native add-ons, operating-system services or future unguarded APIs have no network access. A strict zero-egress environment must also enforce and verify an operating-system firewall rule; that policy will intentionally block automatic updates.

## Store backup and restore

The store is a plain SQLite file, so a backup is a plain bundle: database bytes plus any SQLite sidecars present (`-journal`, `-wal`, `-shm`). No key is created or copied. `backupPlaintextStore()` verifies the copy still classifies as the plaintext store before accepting it, and `db:backup` flushes the WAL with `wal_checkpoint(TRUNCATE)` first so the snapshot is consistent. Backups land in `backups/` as `<file>.<stamp>.bak`, and the newest 10 are kept.

Restore validates the source as a regular file (rejecting symlinks) before touching the active store, creates a safety backup of the current database, stages the replacement in the target directory, swaps it in, and re-opens the store. A legacy encrypted bundle is still restorable: a `.bak` with a matching `.bak.key` beside it goes through `restoreBackupBundle()`, which validates the key and database first and swaps database and key together; `openOrConvertStore()` then converts the restored file to plaintext. A failed swap rolls back the previous files; if the subsequent store initialization fails, the handler attempts to reinstall the safety backup.

The UI exposes restore via a file picker for .bak files and requires confirmation. Unit and Electron end-to-end tests exercise restore. Recovery must still be run on a real Windows installation before release; CI evidence is not a substitute for testing the user's own backup file and filesystem permissions.

Neither the database nor its backups are encrypted: anyone who can read the data folder or a backup copy can read every record. Protection is the Windows account, NTFS permissions on the user-data directory, and physical security; the in-product owner/shared profile masking is a display and export control only. See [plaintext store decision](plaintext-store-decision.md).

## Limits and known caveats

The current intake caps are defined in `canonical-data.cjs`: 200 sheets, 5,000 rows per sheet, 400 columns per sheet, 60,000 non-empty rows and 500,000 non-empty cells across the workbook, 200 MiB for the original file, 1,000 media assets, 20 MiB per extracted media item and 60 MiB total extracted media bytes.

Reaching a cap sets the result as truncated (or rejects a limit breach before staging); it must not be represented to the operator as a complete workbook analysis. The original file is still the authoritative archived copy.

ExcelJS does not guarantee that every drawing in every Excel-generated workbook is exposed through the same worksheet image-anchor API. Therefore image bytes and anchor metadata are kept separate, and no image is linked to a project or geographic record solely by proximity or guesswork. Formulas are recorded, not evaluated; cached values are retained as evidence only.

Manual indicator observations are available in a separate owner-only, paged register. Creates and edits validate an active indicator, an existing district, a required period and a unique indicator/district/period key; percentage values cannot exceed 100. Every save records a data source, and updates snapshot the previous observation in `indicator_observation_versions`. The register shows source and version count, but these observations are intentionally not yet included in the existing analysis dashboards or ranking calculations. The owner-only data-quality register lists open/resolved findings with workbook, row, field and promoted-entity context where available; resolution requires a rationale and timestamp and is auditable. Generic entity regions remain staged without promotion. The document center now provides an optional local extraction/OCR worker and RAGFlow evidence retrieval path, but OCR for scanned PDFs, installed models, and live service operation are not yet verified; see [local document processing and search](local-document-processing-and-search.md). Workbook images are not automatically attached to semantic records, and project attachments can be exported but not previewed inline.

## Next engineering steps

1. Define authoritative geographic references and stable official IDs; do not make non-exact name matches authoritative.
2. Complete data dictionaries and shared validation semantics for all current directorate fields and additional entities, including measurement periods and units.
3. Add generic-record and source-region review/promotion, with explicit rules for absent, blank, zero, unknown, not-applicable and deliberate deletion states.
4. Connect approved indicator observations to user-facing analysis and exports only after an explicit methodology and compatibility review; do not silently change legacy calculations.
5. Add in-app preview and classification for project attachments; workbook media must require explicit review before linking to a project or geographic record.
6. Reconcile legacy-to-canonical migrations for stable IDs, old field semantics and unspecified temporal periods, and extend analysis regression coverage.
7. Validate the existing application-layer network allow-list and add OS-level egress restrictions where strict zero-egress is required; runtime guards do not prevent native or operating-system networking.
8. Finish accessibility, large-workbook performance, Windows backup/restore and signed-package validation.

## Test coverage added

`canonical-data.test.cjs` verifies additive/idempotent and rollback-safe migrations, seeding of directorate fields and indicators, canonical-source analysis reads, durable source-byte/cell provenance, hidden worksheet/row handling, formulas, merged ranges and embedded images, explicit project and indicator promotion, manual observation validation/version retention, paged observation reads, quality-issue listing/resolution, project funding and attachment validation/storage/export integrity, prior-version retention and empty-file rejection. `import-staging-wiring.test.cjs` verifies owner-gated project, attachment-export, observation and quality IPC and renderer wiring. `hardening.test.cjs` covers plaintext backup/restore and legacy encrypted bundle restore. The repository CI must pass on both Windows and Linux before this change is considered verified.
