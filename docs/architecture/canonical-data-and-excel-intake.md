# Canonical data model and Excel intake

## Purpose

This document records the additive data model introduced for the offline desktop application and distinguishes what is already executable from the next domain-integration work. Excel is an input format, not the canonical database schema. The encrypted local SQLite database remains the single source of truth for approved application data.

## Current implementation

### Existing analysis compatibility

The current ranking, dashboards, correction form and exported reports still use the legacy `directorates` analysis tables. Their calculations are based on the existing directorate field catalogue and indicator definitions. This implementation has **not** migrated the current analysis engine to the new normalized entities, because doing so without an agreed identity catalogue, period semantics, project identity rules and a verified migration could change established results.

The new model is added alongside those tables. Migrations are additive and idempotent. Existing directorate values, analysis runs and audit history are not dropped or rewritten by this change.

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
3. Saves the original workbook bytes and SHA-256 fingerprint in the encrypted SQLite database.
4. Inventories every worksheet within documented bounds, including hidden state, dimensions, non-empty rows/cells, candidate headers, formula counts, hidden rows, merged ranges, Excel tables, media and image anchors where the library exposes them.
5. Stores each scanned non-empty row and cell with its address, row/column, cell type, raw representation, readable text, formula, cached result and note/comment when available.
6. Stores extractable embedded image bytes separately, with SHA-256 and anchor metadata if available. Assets without a trustworthy worksheet/row anchor remain unassigned.
7. Creates the existing directorate review plan separately. The legacy directorate importer still requires explicit user approval. Project-candidate regions have a separate owner-only mapping and row-approval path into the canonical projects tables. Indicator and generic regions remain staged and unapproved.
8. Updates the intake batch status after the directorate review action and displays a durable intake history.

Staging is transactional: if the file exceeds a scan cap before the write transaction begins, no partial staging batch is committed. The original source file is retained in the encrypted database so the source package can be re-examined without relying on the original path.

## Project-region review and promotion

Project-like regions are now discovered from a conservative combination of recognizable project headers and non-empty tabular rows. Discovery is only a suggestion; it does not write into the canonical project tables.

In owner mode, the intake screen exposes each discovered project region, a bounded row preview and manual column mapping. The operator must review the suggested mapping, explicitly select row numbers and press the promotion action. Shared mode does not expose raw staged cell values or project promotion.

The promotion service currently handles project identity, description/status, estimated and actual costs, currency, ISO-like dates, optional geographic/sector references, and an optional funding partner/amount/currency. It refuses hidden rows, formula-bearing rows, invalid numeric/date values, duplicate project codes, and rows already promoted. It writes projects, funding, source references, row-to-entity promotion records, and unresolved geographic/sector quality issues in a database transaction. The original workbook, cell provenance, selected mapping and source row location remain traceable.

This is deliberately a bounded first entity-specific path. It is not yet a universal import engine: indicator observations, generic entity records, field-level tri-state values, user-defined dictionaries, and attachment-to-entity approval remain separate work. Unmatched geography/sector text is recorded as a quality issue and is not converted into an invented reference.

## Offline-only runtime enforcement

The main process installs application-layer guards for Node HTTP/HTTPS requests, TCP/TLS connection helpers, DNS resolution, UDP socket creation, global fetch/WebSocket, and Electron net requests. The default Electron session also cancels HTTP, HTTPS and WebSocket requests originating from the renderer. Blocked attempts are recorded in a bounded audit structure that the Electron E2E suite checks.

This improves the offline guarantee inside the app process; it is not an OS firewall. Native add-ons, separately launched child processes, operating-system services and other applications can bypass JavaScript-level guards. A release deployment that requires a strict no-egress guarantee must also use endpoint firewall policy or an equivalent OS-level network restriction and verify it on the target Windows image. The app does not claim to prove that the whole device is offline.

## Encrypted backup and restore

A backup is treated as a bundle: encrypted database bytes plus the matching 64-hex-character store.key companion (.bak.key) and any SQLite sidecars present. Creating a database-only backup without its key is rejected. Restore validates the source database, key and any SQLite sidecars as regular files before touching the active database, creates a safety backup of the current store, stages the replacement files in the target directory, swaps the database and key together, and re-opens the restored store. A failed file swap rolls back the previous database/key pair; if the subsequent store initialization fails, the handler attempts to reinstall the safety backup.

The UI exposes restore via a file picker for .bak files and requires confirmation. Unit and Electron end-to-end tests exercise restore. Recovery must still be run on a real Windows installation before release; CI evidence is not a substitute for testing the user's own backup file and filesystem permissions.

## Limits and known caveats

The current intake caps are defined in `canonical-data.cjs`: 200 sheets, 5,000 rows per sheet, 400 columns per sheet, 60,000 non-empty rows and 500,000 non-empty cells across the workbook, 200 MiB for the original file, 1,000 media assets, 20 MiB per extracted media item and 60 MiB total extracted media bytes.

Reaching a cap sets the result as truncated (or rejects a limit breach before staging); it must not be represented to the operator as a complete workbook analysis. The original file is still the authoritative archived copy.

ExcelJS does not guarantee that every drawing in every Excel-generated workbook is exposed through the same worksheet image-anchor API. Therefore image bytes and anchor metadata are kept separate, and no image is linked to a project or geographic record solely by proximity or guesswork. Formulas are recorded, not evaluated; cached values are retained as evidence only.

The new indicator and generic-entity tables remain schema foundations rather than live import destinations. Project regions have a bounded review and promotion path, but the app does not yet provide complete indicator-observation or generic-entity mapping and approval, nor manual editing for all entity types. This change does not implement OCR.

## Next engineering steps

1. Define the authoritative geographic reference catalogue and stable IDs; avoid matching only on names.
2. Define data dictionaries for project, funding, sector, indicator, source and attachment fields, including units, currency, period type, value state and validation rules.
3. Extend the existing import-region review UI to indicator and generic-record classes. Each region must be independently classified, mapped, scored and approved. Unknown headers and uncertain identity matches remain unresolved.
4. Build entity-specific promotion for indicator observations and generic records, while extending the existing project path only when new fields have agreed semantics. Preserve absent field, explicit blank, zero, unknown, not-applicable and deliberate deletion as distinct states.
5. Add manual create/update screens that use the same canonical validation and provenance services as Excel imports.
6. Add managed attachment browsing, preview, export, and explicit reviewed linking to a project/geographic entity. Add Arabic OCR only as an optional proposal requiring human confirmation.
7. Implement field-, record-, dataset-, source- and time-level validation and duplicate/conflict review. Do not infer factual accuracy from format checks alone.
8. Add data migration from the legacy directorate tables with reconciled row counts and analysis regression tests before switching dashboards/ranking to canonical values.
9. Complete managed attachment browsing and explicit review/linking to projects and geographic entities. Binary staging is not proof of semantic attachment.
10. Add OS-level egress restrictions and verify them on the target Windows image; runtime guards alone do not prevent native or operating-system networking.
11. Finish IPC authorization, accessibility, performance, and signed Windows packaging.

## Test coverage added

`canonical-data.test.cjs` verifies additive/idempotent migrations, seeding of existing directorate fields and indicators, durable source-byte and cell provenance storage, hidden worksheet/row handling, formulas, merged ranges, embedded images, review-only staging, project-region mapping and promotion guards, provenance, funding linkage and rejection of empty files. `hardening.test.cjs` covers encrypted backup/restore bundles. The repository CI must pass on both Windows and Linux before this change is considered verified.
