# Unified Development Data Model

## Purpose

This model turns the development data dictionary into a normalized, extensible relational design. The 18 subject domains are represented as a parent/child field-group hierarchy. A canonical field is defined once and can be placed in one or more groups without duplicating its definition or its stored values.

The migration is additive. It does not drop or rename the existing legacy, canonical, analysis, import, or document tables. The current analysis pipeline and approved legacy results continue to use their existing compatibility paths.

## Architecture layers

1. Geographic and temporal references — existing geographic_units, geo_unit_types, and periods remain the source of geographic and time identifiers.
2. Shared dictionaries — existing field_definitions, measurement_units, dimension_definitions, dimension_values, reference_sets, and reference_values are reused. The new field_groups, field_group_fields, field_definition_aliases, and field_dimension_rules provide the hierarchical catalogue, canonical aliases, and permitted disaggregation axes.
3. Records and observations — form_records, record_field_values, observations, observation_dimensions, and value_provenance remain the generic record/value/provenance path. Repeated categories such as sex, age group, education level, ownership, disease, crop, energy source, and status must be stored as dimensions or controlled reference values, not as repeated columns.
4. Domain profiles and facts — dedicated tables capture facility services, staff counts, natural-resource sites, land use, crop production, livestock, fisheries, education enrolment, health services, household welfare, social protection, and economic establishments. Existing school, health-facility, water-asset, road, organization, and project tables are reused.
5. Financial, analytical and planning models — normalized budget accounts and lines, revenue and expenditure transactions, SWOT/PESTLE factors, issue causes/effects/evidence, weighted priority assessments, objectives, programs, activities, milestones, beneficiaries, and indicator calculation snapshots are represented in their own relational tables.

## Field catalogue

field_groups stores the 18 root domains and their subdomains. field_group_fields links each subdomain to canonical field_definitions. This many-to-many link allows a field to appear in more than one appropriate view while preserving one field identity.

The catalogue uses stable field codes, Arabic canonical labels, SQL data types, measurement units and optional controlled reference sets. field_definition_aliases holds approved alternate labels used by import mapping. An alias is a mapping aid; it does not itself authorize data promotion.

field_dimension_rules declares which dimensions can disaggregate a field. observations stores the value and observation_dimensions stores its selected dimension values. Sex and age are therefore dimensions, not columns such as male_0_5, female_0_5, and so on.

The initial catalogue seeds the 18 domain roots and a structured core field set. It also maps exact legacy equivalents to their existing field definitions where a verified semantic equivalent exists. New fields are additive; no approximate equivalence should be silently merged.

## Domain-specific tables

- Population, households and protection: population measurements, household welfare, disability/displacement classifications and social-protection records.
- Natural resources and environment: resource-site profiles, land-use areas, source classifications, and environmental condition observations.
- Governance and social institutions: the existing generic entities/organizations model plus staffing observations and shared reference classifications.
- Education and health: existing institution master records plus dated enrolment, service, disease, and workforce observations.
- Infrastructure: reuse water_assets, road_segments, health_facilities, and facility_services; service coverage remains measured by geography and period.
- Agriculture and local economy: dated crop, livestock, fishery, and establishment records with explicit quantity, area, yield, capacity, unit, and period.
- Finance: financial_accounts form a chart of accounts; budget_headers and budget_lines store approvals/revisions/actuals; revenue and expenditure transactions preserve actual collection/payment events and currency.
- Development analysis: development_issues remains the issue master. Separate factors and evidence records store root causes, direct causes, effects, constraints, opportunities and supporting evidence. priority_criteria and issue_priority_assessments retain raw score, normalized score, applied weight, weighted result and rationale.
- Planning: existing development_plans and plan_priorities are retained. Strategic objectives and programs add a hierarchy; program-project links, activities, milestones, project geography and beneficiary targets describe implementation.
- Indicators: existing indicator definitions and observations are retained. Versioned definitions, numerator/denominator/input components, approved weight profiles, targets, benchmarks, calculation runs, results and result inputs make calculations reproducible and auditable.

## Value states and non-loss rules

Do not coerce blank, zero, unknown, unavailable, not collected, not applicable, and not verified into one state. A missing field in a partial import must not erase a previously stored value. A deletion must be explicit, authorized and reasoned.

Counts and non-negative measures use integer/decimal types and explicit units. Percentages are stored consistently as fractions where the existing engine requires that convention, with display formatting handled by the application. Currency values always carry a currency code. Derived values should store their formula/version and source inputs when persistence is required.

## Provenance and audit

Every approved value should remain traceable to a data source and, when imported, its worksheet/region/row/cell locator. Preserve the raw value, normalized value and transformation rule. Approved changes must have revision history and an actor/reason. The calculation tables preserve algorithm version, input snapshot hash, parameters, weights, missing inputs and the exact observations used.

## Migration and compatibility

The migration runs after the existing canonical and architecture migrations. It uses a separate version/checksum record and transactional DDL/seeding. Repeated execution is idempotent. Foreign-key checks run before successful completion. Existing tables are not dropped, existing legacy data is not rewritten by this migration, and no previously accepted indicator formula or ranking weight is changed.

This schema addition establishes the storage model and reference catalogue. It does not imply that every existing UI form, import adapter, or report has already been rewired to every newly added table. Those application flows must be migrated one domain at a time with round-trip and regression tests before a domain is considered fully live.
