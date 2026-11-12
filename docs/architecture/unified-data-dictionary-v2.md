# قاموس البيانات الموحد v2

هذا القاموس مُولَّد آلياً من `desktop-app/src/main/database/domain-registry.cjs`، وهو المصدر الوحيد لأسماء الجداول والأعمدة والتسميات العربية التي تعرضها شاشة «البيانات التنموية الموحدة». أي إضافة حقل تبدأ من هذا السجل ثم تُسجَّل في ترحيل إضافي، لا العكس.

المحتوى: **45** مجموعة بيانات، **444** حقل موثق، موزعة على **6** طبقات.

## 1. خريطة الطبقات

| الطبقة | التسمية العربية | عدد المجموعات | الجداول |
|---|---|---|---|
| `records` | سجلات البيانات القطاعية | 14 | `facility_services`, `staffing_observations`, `natural_resource_sites`, `land_use_records`, `agricultural_production_records`, `livestock_production_records`, `fisheries_production_records`, `economic_establishments`, `tourism_site_profiles`, `cultural_heritage_profiles`, `education_enrollment_records`, `health_service_records`, `household_welfare_records`, `social_protection_records` |
| `analysis` | التحليل التنموي والقضايا | 6 | `swot_pestle_analyses`, `development_issue_factors`, `development_issue_evidence`, `priority_criteria`, `issue_priority_assessments`, `development_issues` |
| `planning` | التخطيط الاستراتيجي والبرامج | 10 | `development_plans`, `plan_priorities`, `issue_plan_links`, `strategic_objectives`, `development_programs`, `program_projects`, `project_activities`, `project_milestones`, `project_geographic_units`, `project_beneficiary_targets` |
| `finance` | المالية والموازنات | 5 | `financial_accounts`, `budget_headers`, `budget_lines`, `revenue_transactions`, `expenditure_transactions` |
| `indicators` | المؤشرات والقياس | 6 | `indicator_definition_versions`, `indicator_components`, `indicator_weight_profiles`, `indicator_weights`, `indicator_targets`, `indicator_benchmarks` |
| `dictionary` | قاموس الحقول والأبعاد | 4 | `field_groups`, `field_group_fields`, `field_definition_aliases`, `field_dimension_rules` |

## 2. فهرس المجموعات

| المفتاح | التسمية | الطبقة | الجدول | المفتاح الأساسي | عدد الحقول | حالة القيمة |
|---|---|---|---|---|---|---|
| `facilityServices` | خدمات المرافق | `records` | `facility_services` | `facility_service_id` (تلقائي) | 10 | لا |
| `staffingObservations` | ملاحظات الكادر الوظيفي | `records` | `staffing_observations` | `staffing_observation_id` (تلقائي) | 14 | لا |
| `naturalResourceSites` | مواقع الموارد الطبيعية | `records` | `natural_resource_sites` | `entity_id` | 10 | لا |
| `landUseRecords` | سجلات استخدامات الأراضي | `records` | `land_use_records` | `land_use_record_id` (تلقائي) | 12 | لا |
| `agriculturalProductionRecords` | سجلات الإنتاج الزراعي | `records` | `agricultural_production_records` | `production_record_id` (تلقائي) | 18 | لا |
| `livestockProductionRecords` | سجلات الإنتاج الحيواني | `records` | `livestock_production_records` | `livestock_record_id` (تلقائي) | 14 | لا |
| `fisheriesProductionRecords` | سجلات الإنتاج السمكي | `records` | `fisheries_production_records` | `fishery_record_id` (تلقائي) | 13 | لا |
| `economicEstablishments` | المنشآت الاقتصادية | `records` | `economic_establishments` | `entity_id` | 13 | لا |
| `tourismSiteProfiles` | ملفات المواقع السياحية | `records` | `tourism_site_profiles` | `entity_id` | 5 | لا |
| `culturalHeritageProfiles` | ملفات الموروث الثقافي | `records` | `cultural_heritage_profiles` | `entity_id` | 7 | لا |
| `educationEnrollmentRecords` | سجلات الالتحاق بالتعليم | `records` | `education_enrollment_records` | `enrollment_record_id` (تلقائي) | 14 | لا |
| `healthServiceRecords` | سجلات الخدمات الصحية | `records` | `health_service_records` | `health_service_record_id` (تلقائي) | 14 | لا |
| `householdWelfareRecords` | سجلات الرفاه الأسري | `records` | `household_welfare_records` | `welfare_record_id` (تلقائي) | 12 | لا |
| `socialProtectionRecords` | سجلات الحماية الاجتماعية | `records` | `social_protection_records` | `protection_record_id` (تلقائي) | 12 | لا |
| `swotPestleAnalyses` | تحليلات SWOT وPESTLE | `analysis` | `swot_pestle_analyses` | `analysis_id` (تلقائي) | 13 | لا |
| `developmentIssueFactors` | عوامل القضايا التنموية | `analysis` | `development_issue_factors` | `issue_factor_id` (تلقائي) | 6 | لا |
| `developmentIssueEvidence` | أدلة القضايا التنموية | `analysis` | `development_issue_evidence` | `issue_evidence_id` (تلقائي) | 9 | لا |
| `priorityCriteria` | معايير الأولوية | `analysis` | `priority_criteria` | `criterion_id` (تلقائي) | 9 | لا |
| `issuePriorityAssessments` | تقييمات أولوية القضايا | `analysis` | `issue_priority_assessments` | `assessment_id` (تلقائي) | 12 | لا |
| `developmentIssues` | القضايا التنموية | `analysis` | `development_issues` | `issue_id` (تلقائي) | 11 | لا |
| `developmentPlans` | خطط التنمية | `planning` | `development_plans` | `plan_id` (تلقائي) | 9 | لا |
| `planPriorities` | أولويات الخطة | `planning` | `plan_priorities` | `priority_id` (تلقائي) | 12 | لا |
| `issuePlanLinks` | ربط القضايا بالأولويات | `planning` | `issue_plan_links` | `issue_plan_link_id` (تلقائي) | 5 | لا |
| `strategicObjectives` | الأهداف الاستراتيجية | `planning` | `strategic_objectives` | `objective_id` (تلقائي) | 14 | لا |
| `developmentPrograms` | البرامج التنموية | `planning` | `development_programs` | `program_id` (تلقائي) | 12 | لا |
| `programProjects` | ربط البرامج بالمشاريع | `planning` | `program_projects` | `program_id` | 3 | لا |
| `projectActivities` | أنشطة المشاريع | `planning` | `project_activities` | `activity_id` (تلقائي) | 12 | لا |
| `projectMilestones` | مراحل إنجاز المشاريع | `planning` | `project_milestones` | `milestone_id` (تلقائي) | 8 | لا |
| `projectGeographicUnits` | التغطية الجغرافية للمشاريع | `planning` | `project_geographic_units` | `project_id` | 3 | لا |
| `projectBeneficiaryTargets` | مستهدفات المستفيدين | `planning` | `project_beneficiary_targets` | `beneficiary_target_id` (تلقائي) | 8 | لا |
| `financialAccounts` | دليل الحسابات المالية | `finance` | `financial_accounts` | `account_id` (تلقائي) | 6 | لا |
| `budgetHeaders` | رؤوس الموازنات | `finance` | `budget_headers` | `budget_id` (تلقائي) | 9 | لا |
| `budgetLines` | بنود الموازنة | `finance` | `budget_lines` | `budget_line_id` (تلقائي) | 10 | لا |
| `revenueTransactions` | حركات الإيرادات | `finance` | `revenue_transactions` | `revenue_transaction_id` (تلقائي) | 11 | لا |
| `expenditureTransactions` | حركات الإنفاق | `finance` | `expenditure_transactions` | `expenditure_transaction_id` (تلقائي) | 10 | لا |
| `indicatorDefinitionVersions` | إصدارات تعريف المؤشرات | `indicators` | `indicator_definition_versions` | `indicator_version_id` (تلقائي) | 11 | لا |
| `indicatorComponents` | مكونات المؤشرات | `indicators` | `indicator_components` | `component_id` (تلقائي) | 10 | لا |
| `indicatorWeightProfiles` | ملفات أوزان المؤشرات | `indicators` | `indicator_weight_profiles` | `weight_profile_id` (تلقائي) | 9 | لا |
| `indicatorWeights` | أوزان المؤشرات | `indicators` | `indicator_weights` | `indicator_weight_id` (تلقائي) | 6 | لا |
| `indicatorTargets` | مستهدفات المؤشرات | `indicators` | `indicator_targets` | `indicator_target_id` (تلقائي) | 9 | لا |
| `indicatorBenchmarks` | قيم المؤشرات المرجعية | `indicators` | `indicator_benchmarks` | `benchmark_id` (تلقائي) | 10 | لا |
| `fieldGroups` | مجموعات الحقول الدلالية | `dictionary` | `field_groups` | `group_id` (تلقائي) | 9 | لا |
| `fieldGroupFields` | حقول المجموعات الدلالية | `dictionary` | `field_group_fields` | `group_id` | 4 | لا |
| `fieldDefinitionAliases` | أسماء الحقول البديلة | `dictionary` | `field_definition_aliases` | `alias_id` (تلقائي) | 9 | لا |
| `fieldDimensionRules` | قواعد أبعاد الحقول | `dictionary` | `field_dimension_rules` | `field_dimension_rule_id` (تلقائي) | 7 | لا |

## 3. القاموس الحقلي الكامل

### 3.1 سجلات البيانات القطاعية (`records`)

#### `facilityServices` — خدمات المرافق

الجدول: `facility_services` · المفتاح الأساسي: `facility_service_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

الخدمات التي يقدمها مرفق أو منشأة مع طاقتها الاستيعابية وعدد المستفيدين.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `facility_service_id` | معرّف خدمة المرفق | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `facility_entity_id` | المرفق | entity | نعم | `entities.entity_id` | - |
| `service_type_id` | نوع الخدمة | reference | نعم | `reference_values.reference_value_id` | - |
| `period_id` | الفترة المرجعية | period | لا | `periods.period_id` | - |
| `service_status_id` | حالة تقديم الخدمة | reference | لا | `reference_values.reference_value_id` | - |
| `capacity_value` | الطاقة الاستيعابية | decimal | لا | - | - |
| `capacity_unit_id` | وحدة الطاقة الاستيعابية | unit | لا | `measurement_units.unit_id` | - |
| `beneficiaries_count` | عدد المستفيدين | integer | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `staffingObservations` — ملاحظات الكادر الوظيفي

الجدول: `staffing_observations` · المفتاح الأساسي: `staffing_observation_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

أعداد العاملين في جهة أو مكان عمل حسب الفئة والتخصص والجنس والمؤهل.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `staffing_observation_id` | معرّف ملاحظة الكادر | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `organization_entity_id` | الجهة المنظمة | entity | نعم | `entities.entity_id` | - |
| `workplace_entity_id` | مكان العمل | entity | لا | `entities.entity_id` | - |
| `geo_unit_id` | الوحدة الجغرافية | geo | لا | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `staff_category_id` | فئة الكادر | reference | لا | `reference_values.reference_value_id` | - |
| `employment_type_id` | نوع التوظيف | reference | لا | `reference_values.reference_value_id` | - |
| `sex_value_id` | الجنس | dimension | لا | `dimension_values.dimension_value_id` | - |
| `education_value_id` | المؤهل العلمي | dimension | لا | `dimension_values.dimension_value_id` | - |
| `specialty_id` | التخصص | reference | لا | `reference_values.reference_value_id` | - |
| `headcount` | عدد العاملين | integer | نعم | - | - |
| `required_headcount` | العدد اللازم من العاملين | integer | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `naturalResourceSites` — مواقع الموارد الطبيعية

الجدول: `natural_resource_sites` · المفتاح الأساسي: `entity_id` · حالة القيمة: غير مستخدمة.

بيانات الموارد الطبيعية (مساحة وسعة وحالة واستخدام) لموقع مسجل ككيان.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `entity_id` | الموقع | entity | نعم | `entities.entity_id` | المعرّف الأساسي: مرجع الكيان نفسه. |
| `resource_type_id` | نوع المورد الطبيعي | reference | نعم | `reference_values.reference_value_id` | - |
| `area_value` | المساحة | decimal | لا | - | - |
| `area_unit_id` | وحدة المساحة | unit | لا | `measurement_units.unit_id` | - |
| `capacity_value` | السعة | decimal | لا | - | - |
| `capacity_unit_id` | وحدة السعة | unit | لا | `measurement_units.unit_id` | - |
| `condition_id` | الحالة الراهنة | reference | لا | `reference_values.reference_value_id` | - |
| `use_type_id` | نوع الاستخدام | reference | لا | `reference_values.reference_value_id` | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `landUseRecords` — سجلات استخدامات الأراضي

الجدول: `land_use_records` · المفتاح الأساسي: `land_use_record_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

مساحات استخدامات الأراضي في وحدة جغرافية وفترة حسب النوع والملكية والتربة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `land_use_record_id` | معرّف سجل استخدام الأرض | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `land_use_type_id` | نوع استخدام الأرض | reference | نعم | `reference_values.reference_value_id` | - |
| `ownership_type_id` | نوع الملكية | reference | لا | `reference_values.reference_value_id` | - |
| `soil_type_id` | نوع التربة | reference | لا | `reference_values.reference_value_id` | - |
| `area_value` | المساحة | decimal | نعم | - | - |
| `area_unit_id` | وحدة المساحة | unit | نعم | `measurement_units.unit_id` | - |
| `irrigated` | مروية | boolean | لا | - | - |
| `irrigation_source_id` | مصدر الري | reference | لا | `reference_values.reference_value_id` | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `agriculturalProductionRecords` — سجلات الإنتاج الزراعي

الجدول: `agricultural_production_records` · المفتاح الأساسي: `production_record_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

إنتاج المحاصيل بحسب الوحدة الجغرافية والفترة: المساحة والكمية والإنتاجية والمبيعات.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `production_record_id` | معرّف سجل الإنتاج | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `producer_entity_id` | المنتج | entity | لا | `entities.entity_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `crop_type_id` | نوع المحصول | reference | نعم | `reference_values.reference_value_id` | - |
| `crop_category_id` | فئة المحصول | reference | لا | `reference_values.reference_value_id` | - |
| `cultivated_area` | المساحة المزروعة | decimal | لا | - | - |
| `area_unit_id` | وحدة المساحة | unit | لا | `measurement_units.unit_id` | - |
| `production_quantity` | كمية الإنتاج | decimal | لا | - | - |
| `production_unit_id` | وحدة كمية الإنتاج | unit | لا | `measurement_units.unit_id` | - |
| `yield_value` | الإنتاجية | decimal | لا | - | - |
| `yield_unit_id` | وحدة الإنتاجية | unit | لا | `measurement_units.unit_id` | - |
| `irrigation_source_id` | مصدر الري | reference | لا | `reference_values.reference_value_id` | - |
| `sales_quantity` | الكمية المباعة | decimal | لا | - | - |
| `sales_value` | قيمة المبيعات | decimal | لا | - | - |
| `currency_code` | رمز العملة | currency | لا | `currencies.currency_code` | يُشتق عمود القيمة الدقيقة (minor units) تلقائياً عند وجوده. |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `livestockProductionRecords` — سجلات الإنتاج الحيواني

الجدول: `livestock_production_records` · المفتاح الأساسي: `livestock_record_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

أعداد الثروة الحيوانية والمربين والإصابات والوفيات والنفوق حسب النوع والفترة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `livestock_record_id` | معرّف سجل الثروة الحيوانية | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `producer_entity_id` | المربي | entity | لا | `entities.entity_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `species_id` | نوع الحيوان | reference | نعم | `reference_values.reference_value_id` | - |
| `animal_count` | عدد الرؤوس | integer | لا | - | - |
| `producer_count` | عدد المربين | integer | لا | - | - |
| `average_holding` | متوسط الحيازة | decimal | لا | - | - |
| `disease_id` | المرض الحيواني | reference | لا | `reference_values.reference_value_id` | - |
| `infected_count` | عدد الإصابات | integer | لا | - | - |
| `deaths_count` | عدد الوفيات | integer | لا | - | - |
| `treatment_type_id` | نوع المعالجة | reference | لا | `reference_values.reference_value_id` | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `fisheriesProductionRecords` — سجلات الإنتاج السمكي

الجدول: `fisheries_production_records` · المفتاح الأساسي: `fishery_record_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

الإنتاج السمكي وأعداد القوارب والصيادين وحجم التصدير في منطقة صيد وفترة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `fishery_record_id` | معرّف سجل الصيد | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `operator_entity_id` | المشغل | entity | لا | `entities.entity_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `fishery_zone_id` | منطقة الصيد | reference | لا | `reference_values.reference_value_id` | - |
| `vessel_type_id` | نوع قارب الصيد | reference | لا | `reference_values.reference_value_id` | - |
| `vessel_count` | عدد القوارب | integer | لا | - | - |
| `fisher_count` | عدد الصيادين | integer | لا | - | - |
| `production_quantity` | كمية الإنتاج | decimal | لا | - | - |
| `production_unit_id` | وحدة كمية الإنتاج | unit | لا | `measurement_units.unit_id` | - |
| `export_quantity` | كمية التصدير | decimal | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `economicEstablishments` — المنشآت الاقتصادية

الجدول: `economic_establishments` · المفتاح الأساسي: `entity_id` · حالة القيمة: غير مستخدمة.

بيانات المنشأة الاقتصادية: النشاط والحجم والملكية والعاملون والإنتاج والمواد الخام.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `entity_id` | المنشأة | entity | نعم | `entities.entity_id` | المعرّف الأساسي: مرجع الكيان نفسه. |
| `activity_type_id` | النشاط الاقتصادي | reference | نعم | `reference_values.reference_value_id` | - |
| `establishment_size_id` | حجم المنشأة | reference | لا | `reference_values.reference_value_id` | - |
| `ownership_type_id` | نوع الملكية | reference | لا | `reference_values.reference_value_id` | - |
| `employee_count` | عدد العاملين | integer | لا | - | - |
| `female_employee_count` | عدد العاملات | integer | لا | - | - |
| `annual_production_quantity` | كمية الإنتاج السنوي | decimal | لا | - | - |
| `annual_production_unit_id` | وحدة الإنتاج السنوي | unit | لا | `measurement_units.unit_id` | - |
| `annual_production_value` | قيمة الإنتاج السنوي | decimal | لا | - | - |
| `currency_code` | رمز العملة | currency | لا | `currencies.currency_code` | يُشتق عمود القيمة الدقيقة (minor units) تلقائياً عند وجوده. |
| `raw_material_type_id` | نوع المادة الخام | reference | لا | `reference_values.reference_value_id` | - |
| `raw_material_origin_id` | مصدر المادة الخام | reference | لا | `reference_values.reference_value_id` | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `tourismSiteProfiles` — ملفات المواقع السياحية

الجدول: `tourism_site_profiles` · المفتاح الأساسي: `entity_id` · حالة القيمة: غير مستخدمة.

الملف التعريفي للموقع السياحي: النوع وإمكانية الوصول ووصف الخدمات المتاحة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `entity_id` | الموقع السياحي | entity | نعم | `entities.entity_id` | المعرّف الأساسي: مرجع الكيان نفسه. |
| `tourism_type_id` | نوع السياحة | reference | لا | `reference_values.reference_value_id` | - |
| `accessibility_id` | إمكانية الوصول | reference | لا | `reference_values.reference_value_id` | - |
| `visitor_services_description` | وصف الخدمات المتاحة للزوار | long_text | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `culturalHeritageProfiles` — ملفات الموروث الثقافي

الجدول: `cultural_heritage_profiles` · المفتاح الأساسي: `entity_id` · حالة القيمة: غير مستخدمة.

الملف التعريفي لعنصر الموروث الثقافي: النوع وموسم الممارسة والوضع وإجراءات الصون.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `entity_id` | عنصر الموروث | entity | نعم | `entities.entity_id` | المعرّف الأساسي: مرجع الكيان نفسه. |
| `heritage_type_id` | نوع الموروث | reference | نعم | `reference_values.reference_value_id` | - |
| `practice_season` | موسم الممارسة | text | لا | - | - |
| `current_condition_id` | الوضع الحالي | reference | لا | `reference_values.reference_value_id` | - |
| `description` | وصف الموروث | long_text | لا | - | - |
| `preservation_measures` | إجراءات الصون | long_text | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `educationEnrollmentRecords` — سجلات الالتحاق بالتعليم

الجدول: `education_enrollment_records` · المفتاح الأساسي: `enrollment_record_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

أعداد المستهدفين والملتحقين والمتسربين والمعلمين حسب المستوى والصف والجنس والفئة العمرية.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `enrollment_record_id` | معرّف سجل الالتحاق | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `facility_entity_id` | المرفق التعليمي | entity | لا | `entities.entity_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `education_level_id` | المستوى التعليمي | reference | نعم | `reference_values.reference_value_id` | - |
| `grade_id` | الصف الدراسي | reference | لا | `reference_values.reference_value_id` | - |
| `sex_value_id` | الجنس | dimension | لا | `dimension_values.dimension_value_id` | - |
| `age_group_value_id` | الفئة العمرية | dimension | لا | `dimension_values.dimension_value_id` | - |
| `target_count` | عدد المستهدفين | integer | لا | - | - |
| `enrolled_count` | عدد الملتحقين | integer | لا | - | - |
| `dropout_count` | عدد المتسربين | integer | لا | - | - |
| `teacher_count` | عدد المعلمين | integer | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `healthServiceRecords` — سجلات الخدمات الصحية

الجدول: `health_service_records` · المفتاح الأساسي: `health_service_record_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

الخدمات الصحية المقدمة والحالات والوفيات حسب المرفق والمرض والجنس والفئة العمرية.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `health_service_record_id` | معرّف سجل الخدمة الصحية | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `facility_entity_id` | المرفق الصحي | entity | لا | `entities.entity_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `service_type_id` | نوع الخدمة الصحية | reference | لا | `reference_values.reference_value_id` | - |
| `disease_id` | المرض | reference | لا | `reference_values.reference_value_id` | - |
| `sex_value_id` | الجنس | dimension | لا | `dimension_values.dimension_value_id` | - |
| `age_group_value_id` | الفئة العمرية | dimension | لا | `dimension_values.dimension_value_id` | - |
| `target_count` | عدد المستهدفين | integer | لا | - | - |
| `served_count` | عدد المستفيدين | integer | لا | - | - |
| `case_count` | عدد الحالات | integer | لا | - | - |
| `death_count` | عدد الوفيات | integer | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `householdWelfareRecords` — سجلات الرفاه الأسري

الجدول: `household_welfare_records` · المفتاح الأساسي: `welfare_record_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

أعداد الأسر والفقراء ومستوى الدخل والإنفاق مقارنة بخط الفقر في وحدة جغرافية وفترة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `welfare_record_id` | معرّف سجل الرفاه | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `poverty_line_type_id` | نوع خط الفقر | reference | لا | `reference_values.reference_value_id` | - |
| `welfare_category_id` | فئة الرفاه | reference | لا | `reference_values.reference_value_id` | - |
| `household_count` | عدد الأسر | integer | لا | - | - |
| `poor_household_count` | عدد الأسر الفقيرة | integer | لا | - | - |
| `income_value` | قيمة الدخل | decimal | لا | - | - |
| `expenditure_value` | قيمة الإنفاق | decimal | لا | - | - |
| `currency_code` | رمز العملة | currency | لا | `currencies.currency_code` | يُشتق عمود القيمة الدقيقة (minor units) تلقائياً عند وجوده. |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `socialProtectionRecords` — سجلات الحماية الاجتماعية

الجدول: `social_protection_records` · المفتاح الأساسي: `protection_record_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

أعداد المستحقين والمستفيدين والمبالغ المنصرفة من برامج الحماية الاجتماعية ودورة الصرف.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `protection_record_id` | معرّف سجل الحماية | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `beneficiary_group_id` | فئة المستفيدين | reference | لا | `reference_values.reference_value_id` | - |
| `implementing_entity_id` | الجهة المنفذة | entity | لا | `entities.entity_id` | - |
| `eligible_count` | عدد المستحقين | integer | لا | - | - |
| `beneficiary_count` | عدد المستفيدين | integer | لا | - | - |
| `amount_paid` | المبلغ المنصرف | decimal | لا | - | - |
| `currency_code` | رمز العملة | currency | لا | `currencies.currency_code` | يُشتق عمود القيمة الدقيقة (minor units) تلقائياً عند وجوده. |
| `payment_cycle_id` | دورة الصرف | reference | لا | `reference_values.reference_value_id` | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

### 3.2 التحليل التنموي والقضايا (`analysis`)

#### `swotPestleAnalyses` — تحليلات SWOT وPESTLE

الجدول: `swot_pestle_analyses` · المفتاح الأساسي: `analysis_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

عوامل التحليل الرباعي SWOT أو البيئي PESTLE مع تقدير الأثر والاستجابة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `analysis_id` | معرّف التحليل | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | لا | `periods.period_id` | - |
| `analysis_type` | نوع التحليل | text | نعم | - | - |
| `factor_type` | نوع العامل | text | نعم | - | بلا قيد CHECK في المخطط: strength/weakness/opportunity/threat لتحليل SWOT، وpolitical/economic/social/technological/legal/environmental لتحليل PESTLE. |
| `title` | العنوان | text | نعم | - | - |
| `description` | الوصف | long_text | لا | - | - |
| `evidence_summary` | ملخص الأدلة | long_text | لا | - | - |
| `impact_direction` | اتجاه الأثر | text | لا | - | - |
| `impact_severity` | شدة الأثر | decimal | لا | - | - |
| `time_horizon` | المدى الزمني | text | لا | - | - |
| `response_strategy` | استراتيجية الاستجابة | long_text | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `developmentIssueFactors` — عوامل القضايا التنموية

الجدول: `development_issue_factors` · المفتاح الأساسي: `issue_factor_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

أسباب القضية التنموية وآثارها وقيودها وفرصها ومخاطرها مع درجة الشدة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `issue_factor_id` | معرّف عامل القضية | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `issue_id` | القضية التنموية | reference | نعم | `development_issues.issue_id` | - |
| `factor_type` | نوع العامل | text | نعم | - | - |
| `description` | وصف العامل | long_text | نعم | - | - |
| `severity` | درجة الشدة | decimal | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `developmentIssueEvidence` — أدلة القضايا التنموية

الجدول: `development_issue_evidence` · المفتاح الأساسي: `issue_evidence_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

الدليل الداعم للقضية التنموية مع جغرافيته وفترته ومصدره ودرجة ثقته.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `issue_evidence_id` | معرّف الدليل | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `issue_id` | القضية التنموية | reference | نعم | `development_issues.issue_id` | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `evidence_type` | نوع الدليل | text | نعم | - | - |
| `description` | وصف الدليل | long_text | لا | - | - |
| `geo_unit_id` | الوحدة الجغرافية | geo | لا | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | لا | `periods.period_id` | - |
| `source_locator` | موضع الدليل في المصدر | text | لا | - | - |
| `confidence` | درجة الثقة | decimal | لا | - | - |

#### `priorityCriteria` — معايير الأولوية

الجدول: `priority_criteria` · المفتاح الأساسي: `criterion_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

معايير ترجيح أولويات القضايا بأوزانها الافتراضية واتجاهها ومقياسها.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `criterion_id` | معرّف المعيار | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `criterion_code` | رمز المعيار | text | نعم | - | - |
| `name_ar` | اسم المعيار | text | نعم | - | - |
| `description` | وصف المعيار | long_text | لا | - | - |
| `default_weight` | الوزن الافتراضي | decimal | نعم | - | - |
| `direction` | اتجاه الترجيح | text | لا | - | القيمة الافتراضية higher_is_higher؛ لا يوجد قيد CHECK على القيم. |
| `scale_min` | الحد الأدنى للمقياس | decimal | لا | - | يجب أن يكون أصغر من الحد الأعلى عند تعبئتهما. |
| `scale_max` | الحد الأعلى للمقياس | decimal | لا | - | يجب أن يكون أكبر من الحد الأدنى عند تعبئتهما. |
| `is_active` | فعال | boolean | لا | - | - |

#### `issuePriorityAssessments` — تقييمات أولوية القضايا

الجدول: `issue_priority_assessments` · المفتاح الأساسي: `assessment_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

درجة القضية التنموية على معيار أولوية مع الوزن المطبق والدرجة المرجحة والمبرر.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `assessment_id` | معرّف التقييم | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `issue_id` | القضية التنموية | reference | نعم | `development_issues.issue_id` | - |
| `criterion_id` | معيار الأولوية | reference | نعم | `priority_criteria.criterion_id` | - |
| `period_id` | الفترة المرجعية | period | لا | `periods.period_id` | - |
| `raw_score` | الدرجة الخام | decimal | نعم | - | - |
| `normalized_score` | الدرجة المعيارية | decimal | لا | - | - |
| `applied_weight` | الوزن المطبق | decimal | نعم | - | - |
| `weighted_score` | الدرجة المرجحة | decimal | نعم | - | - |
| `rationale` | مبرر التقييم | long_text | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `assessed_by` | المقيّم | text | لا | - | - |
| `assessed_at` | وقت التقييم | datetime | نعم | - | - |

#### `developmentIssues` — القضايا التنموية

الجدول: `development_issues` · المفتاح الأساسي: `issue_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

القضايا التنموية المرتبطة بالموقع والقطاع، وتُبنى عليها الأسباب والأدلة والأولويات.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `issue_id` | معرّف القضية | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `form_record_id` | سجل النموذج | reference | لا | `form_records.form_record_id` | - |
| `geo_unit_id` | الوحدة الجغرافية | geo | لا | `geographic_units.geo_unit_id` | - |
| `sector_id` | القطاع | sector | لا | `sectors.sector_id` | - |
| `issue_code` | رمز القضية | text | لا | - | - |
| `issue_title` | عنوان القضية | text | نعم | - | - |
| `issue_description` | وصف القضية | long_text | لا | - | - |
| `general_challenge` | التحدي العام | long_text | لا | - | - |
| `population_share` | نسبة السكان المتأثرين | decimal | لا | - | - |
| `evidence_notes` | ملاحظات الأدلة | long_text | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

### 3.3 التخطيط الاستراتيجي والبرامج (`planning`)

#### `developmentPlans` — خطط التنمية

الجدول: `development_plans` · المفتاح الأساسي: `plan_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

خطط التنمية المحلية التي ترتبط بها الأهداف والبرامج والأولويات.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `plan_id` | معرّف الخطة | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | لا | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | لا | `periods.period_id` | - |
| `plan_code` | رمز الخطة | text | لا | - | - |
| `plan_name` | اسم الخطة | text | نعم | - | - |
| `general_goal` | الهدف العام | long_text | لا | - | - |
| `plan_status` | حالة الخطة | text | لا | - | القيمة الافتراضية draft؛ لا يوجد قيد CHECK في المخطط. |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `created_by` | منشئ الخطة | text | لا | - | - |

#### `planPriorities` — أولويات الخطة

الجدول: `plan_priorities` · المفتاح الأساسي: `priority_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

بنود أولويات الخطة: المحور والهدف والمشروع الفرعي وقيمة الاستهداف.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `priority_id` | معرّف الأولوية | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `plan_id` | الخطة | reference | نعم | `development_plans.plan_id` | - |
| `priority_rank` | الترتيب | integer | لا | - | - |
| `axis_name` | المحور | text | لا | - | - |
| `sector_id` | القطاع | sector | لا | `sectors.sector_id` | - |
| `objective_text` | نص الهدف | long_text | لا | - | - |
| `sub_program_text` | البرنامج الفرعي | long_text | لا | - | - |
| `program_text` | البرنامج | long_text | لا | - | - |
| `target_value` | القيمة المستهدفة | decimal | لا | - | - |
| `target_unit_id` | وحدة القيمة المستهدفة | unit | لا | `measurement_units.unit_id` | - |
| `target_period_id` | فترة الاستهداف | period | لا | `periods.period_id` | - |
| `source_record_id` | سجل المصدر | reference | لا | `form_records.form_record_id` | - |

#### `issuePlanLinks` — ربط القضايا بالأولويات

الجدول: `issue_plan_links` · المفتاح الأساسي: `issue_plan_link_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

العلاقة بين القضية التنموية وبند الأولوية في الخطة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `issue_plan_link_id` | معرّف الربط | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `issue_id` | القضية | reference | نعم | `development_issues.issue_id` | - |
| `priority_id` | بند الأولوية | reference | نعم | `plan_priorities.priority_id` | - |
| `relationship_type` | نوع العلاقة | text | نعم | - | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `strategicObjectives` — الأهداف الاستراتيجية

الجدول: `strategic_objectives` · المفتاح الأساسي: `objective_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

أهداف الخطة التنموية بمستوياتها وقيمها الأساسية والمستهدفة ووحداتها وفتراتها.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `objective_id` | معرّف الهدف | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `plan_id` | الخطة التنموية | reference | لا | `development_plans.plan_id` | - |
| `parent_objective_id` | الهدف الأعلى | reference | لا | `strategic_objectives.objective_id` | - |
| `objective_code` | رمز الهدف | text | نعم | - | - |
| `objective_level` | مستوى الهدف | text | نعم | - | - |
| `title` | عنوان الهدف | text | نعم | - | - |
| `description` | وصف الهدف | long_text | لا | - | - |
| `sector_id` | القطاع | sector | لا | `sectors.sector_id` | - |
| `baseline_value` | القيمة الأساسية | decimal | لا | - | - |
| `target_value` | القيمة المستهدفة | decimal | لا | - | - |
| `target_unit_id` | وحدة القيمة المستهدفة | unit | لا | `measurement_units.unit_id` | - |
| `target_period_id` | فترة الاستهداف | period | لا | `periods.period_id` | - |
| `responsible_entity_id` | الجهة المسؤولة | entity | لا | `entities.entity_id` | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `developmentPrograms` — البرامج التنموية

الجدول: `development_programs` · المفتاح الأساسي: `program_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

البرامج التنموية وربطها بالهدف والقطاع وفترة البداية والنهاية والحالة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `program_id` | معرّف البرنامج | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `plan_id` | الخطة التنموية | reference | لا | `development_plans.plan_id` | - |
| `objective_id` | الهدف الاستراتيجي | reference | لا | `strategic_objectives.objective_id` | - |
| `parent_program_id` | البرنامج الأعلى | reference | لا | `development_programs.program_id` | - |
| `program_code` | رمز البرنامج | text | نعم | - | - |
| `program_name` | اسم البرنامج | text | نعم | - | - |
| `program_description` | وصف البرنامج | long_text | لا | - | - |
| `sector_id` | القطاع | sector | لا | `sectors.sector_id` | - |
| `start_period_id` | فترة البداية | period | لا | `periods.period_id` | - |
| `end_period_id` | فترة النهاية | period | لا | `periods.period_id` | - |
| `program_status` | حالة البرنامج | text | لا | - | القيمة الافتراضية draft؛ لا يوجد قيد CHECK على القيم. |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `programProjects` — ربط البرامج بالمشاريع

الجدول: `program_projects` · المفتاح الأساسي: `program_id` · حالة القيمة: غير مستخدمة.

جدول ربط: أي مشروع ينفذ أي برنامج وبأي نوع علاقة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `program_id` | البرنامج | reference | نعم | `development_programs.program_id` | - |
| `project_id` | المشروع | reference | نعم | `projects.id` | - |
| `relationship_type` | نوع العلاقة | text | لا | - | القيمة الافتراضية implements؛ لا يوجد قيد CHECK على القيم. |

#### `projectActivities` — أنشطة المشاريع

الجدول: `project_activities` · المفتاح الأساسي: `activity_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

أنشطة المشروع وتسلسلها الزمني والجهة المسؤولة عنها ونسبة إنجازها.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `activity_id` | معرّف النشاط | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `project_id` | المشروع | reference | نعم | `projects.id` | - |
| `parent_activity_id` | النشاط الأعلى | reference | لا | `project_activities.activity_id` | - |
| `activity_code` | رمز النشاط | text | لا | - | - |
| `activity_name` | اسم النشاط | text | نعم | - | - |
| `description` | وصف النشاط | long_text | لا | - | - |
| `start_date` | تاريخ البداية | date | لا | - | - |
| `end_date` | تاريخ النهاية | date | لا | - | يجب ألا يسبق تاريخ البداية. |
| `responsible_entity_id` | الجهة المسؤولة | entity | لا | `entities.entity_id` | - |
| `activity_status` | حالة النشاط | text | لا | - | القيمة الافتراضية planned؛ لا يوجد قيد CHECK على القيم. |
| `progress_ratio` | نسبة الإنجاز | decimal | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `projectMilestones` — مراحل إنجاز المشاريع

الجدول: `project_milestones` · المفتاح الأساسي: `milestone_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

المعالم الرئيسية للمشروع بتواريخها المستحقة والفعلية وحالتها ودليلها.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `milestone_id` | معرّف المعلم | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `project_id` | المشروع | reference | نعم | `projects.id` | - |
| `milestone_name` | اسم المعلم | text | نعم | - | - |
| `due_date` | التاريخ المستحق | date | لا | - | - |
| `achieved_date` | تاريخ التحقق | date | لا | - | - |
| `milestone_status` | حالة المعلم | text | لا | - | القيمة الافتراضية planned؛ لا يوجد قيد CHECK على القيم. |
| `evidence_source_id` | مصدر الدليل | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `projectGeographicUnits` — التغطية الجغرافية للمشاريع

الجدول: `project_geographic_units` · المفتاح الأساسي: `project_id` · حالة القيمة: غير مستخدمة.

جدول ربط: الوحدات الجغرافية التي يغطيها المشروع ودور كل وحدة فيه.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `project_id` | المشروع | reference | نعم | `projects.id` | - |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `role` | دور الوحدة الجغرافية | text | لا | - | القيمة الافتراضية beneficiary_area؛ لا يوجد قيد CHECK على القيم. |

#### `projectBeneficiaryTargets` — مستهدفات المستفيدين

الجدول: `project_beneficiary_targets` · المفتاح الأساسي: `beneficiary_target_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

أعداد المستفيدين المستهدفين والفعليين للمشروع حسب الفئة والوحدة الجغرافية والفترة.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `beneficiary_target_id` | معرّف مستهدف المستفيدين | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `project_id` | المشروع | reference | نعم | `projects.id` | - |
| `beneficiary_group_id` | فئة المستفيدين | reference | لا | `reference_values.reference_value_id` | - |
| `geo_unit_id` | الوحدة الجغرافية | geo | لا | `geographic_units.geo_unit_id` | - |
| `target_count` | العدد المستهدف | integer | لا | - | - |
| `actual_count` | العدد الفعلي | integer | لا | - | - |
| `period_id` | الفترة المرجعية | period | لا | `periods.period_id` | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

### 3.4 المالية والموازنات (`finance`)

#### `financialAccounts` — دليل الحسابات المالية

الجدول: `financial_accounts` · المفتاح الأساسي: `account_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

شجرة الحسابات المالية: الرمز والاسم والنوع والحساب الأعلى وحالة الفعالية.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `account_id` | معرّف الحساب | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `account_code` | رمز الحساب | text | نعم | - | - |
| `account_name_ar` | اسم الحساب | text | نعم | - | - |
| `account_type` | نوع الحساب | text | نعم | - | - |
| `parent_account_id` | الحساب الأعلى | account | لا | `financial_accounts.account_id` | - |
| `is_active` | فعال | boolean | لا | - | - |

#### `budgetHeaders` — رؤوس الموازنات

الجدول: `budget_headers` · المفتاح الأساسي: `budget_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

الموازنة على مستوى الوحدة الجغرافية والفترة: الرمز والاسم والحالة والعملة والاعتماد.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `budget_id` | معرّف الموازنة | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | لا | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `budget_code` | رمز الموازنة | text | نعم | - | - |
| `budget_name` | اسم الموازنة | text | نعم | - | - |
| `budget_status` | حالة الموازنة | text | لا | - | القيمة الافتراضية draft؛ لا يوجد قيد CHECK على القيم. |
| `currency_code` | رمز العملة | currency | نعم | `currencies.currency_code` | يُشتق عمود القيمة الدقيقة (minor units) تلقائياً عند وجوده. |
| `approved_at` | تاريخ الاعتماد | datetime | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `budgetLines` — بنود الموازنة

الجدول: `budget_lines` · المفتاح الأساسي: `budget_line_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

بنود الموازنة حسب الحساب والقطاع: المبلغ المعتمد والمعدل والفعلي وعملته.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `budget_line_id` | معرّف بند الموازنة | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `budget_id` | الموازنة | reference | نعم | `budget_headers.budget_id` | - |
| `account_id` | الحساب المالي | account | نعم | `financial_accounts.account_id` | - |
| `sector_id` | القطاع | sector | لا | `sectors.sector_id` | - |
| `approved_amount` | المبلغ المعتمد | decimal | لا | - | - |
| `revised_amount` | المبلغ المعدل | decimal | لا | - | - |
| `actual_amount` | المبلغ الفعلي | decimal | لا | - | - |
| `currency_code` | رمز العملة | currency | نعم | `currencies.currency_code` | يُشتق عمود القيمة الدقيقة (minor units) تلقائياً عند وجوده. |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `revenueTransactions` — حركات الإيرادات

الجدول: `revenue_transactions` · المفتاح الأساسي: `revenue_transaction_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

الإيراد المحصل والربط والمورّد على مستوى الوحدة الجغرافية والفترة والحساب.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `revenue_transaction_id` | معرّف حركة الإيراد | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `account_id` | الحساب المالي | account | نعم | `financial_accounts.account_id` | - |
| `collecting_entity_id` | الجهة المحصلة | entity | لا | `entities.entity_id` | - |
| `assessed_amount` | قيمة الربط | decimal | لا | - | - |
| `collected_amount` | المبلغ المحصل | decimal | نعم | - | - |
| `remitted_amount` | المبلغ المورّد | decimal | لا | - | - |
| `currency_code` | رمز العملة | currency | نعم | `currencies.currency_code` | يُشتق عمود القيمة الدقيقة (minor units) تلقائياً عند وجوده. |
| `transaction_date` | تاريخ الحركة | date | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `expenditureTransactions` — حركات الإنفاق

الجدول: `expenditure_transactions` · المفتاح الأساسي: `expenditure_transaction_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

المنصرف الفعلي على مستوى الوحدة الجغرافية والفترة والحساب والمشروع.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `expenditure_transaction_id` | معرّف حركة الإنفاق | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `geo_unit_id` | الوحدة الجغرافية | geo | نعم | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `account_id` | الحساب المالي | account | نعم | `financial_accounts.account_id` | - |
| `project_id` | المشروع | reference | لا | `projects.id` | - |
| `paid_amount` | المبلغ المنصرف | decimal | نعم | - | - |
| `currency_code` | رمز العملة | currency | نعم | `currencies.currency_code` | يُشتق عمود القيمة الدقيقة (minor units) تلقائياً عند وجوده. |
| `transaction_date` | تاريخ الحركة | date | لا | - | - |
| `expenditure_status` | حالة الإنفاق | text | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

### 3.5 المؤشرات والقياس (`indicators`)

#### `indicatorDefinitionVersions` — إصدارات تعريف المؤشرات

الجدول: `indicator_definition_versions` · المفتاح الأساسي: `indicator_version_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

الإصدار المجمّد لتعريف المؤشر ومنهجيته وفترة سريانه وجهة اعتماده.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `indicator_version_id` | معرّف إصدار المؤشر | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `indicator_id` | المؤشر | reference | نعم | `indicator_definitions.id` | - |
| `version_number` | رقم الإصدار | integer | نعم | - | - |
| `definition_json` | تعريف المؤشر (JSON) | long_text | نعم | - | - |
| `methodology` | المنهجية | long_text | لا | - | - |
| `formula_version` | إصدار المعادلة | text | لا | - | - |
| `effective_from` | ساري من | date | لا | - | - |
| `effective_to` | ساري إلى | date | لا | - | يجب ألا يسبق تاريخ السريان. |
| `change_reason` | سبب التغيير | long_text | لا | - | - |
| `approved_by` | المعتمد | text | لا | - | - |
| `approved_at` | تاريخ الاعتماد | datetime | لا | - | - |

#### `indicatorComponents` — مكونات المؤشرات

الجدول: `indicator_components` · المفتاح الأساسي: `component_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

مكونات معادلة المؤشر وأدوارها (بسط، مقام، مدخل، وزن، حد، ثابت) وتعبيراتها.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `component_id` | معرّف المكوّن | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `indicator_version_id` | إصدار المؤشر | reference | نعم | `indicator_definition_versions.indicator_version_id` | - |
| `component_code` | رمز المكوّن | text | نعم | - | - |
| `component_role` | دور المكوّن | text | نعم | - | - |
| `field_definition_id` | تعريف الحقل المرجعي | reference | لا | `field_definitions.field_definition_id` | - |
| `source_indicator_id` | المؤشر المصدر | reference | لا | `indicator_definitions.id` | - |
| `expression` | التعبير الحسابي | long_text | لا | - | - |
| `unit_id` | وحدة القياس | unit | لا | `measurement_units.unit_id` | - |
| `is_required` | إلزامي | boolean | لا | - | - |
| `sort_order` | ترتيب العرض | integer | لا | - | - |

#### `indicatorWeightProfiles` — ملفات أوزان المؤشرات

الجدول: `indicator_weight_profiles` · المفتاح الأساسي: `weight_profile_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

ملف أوزان المؤشرات ومنهجيته وجهة اعتماده وحالة تفعيله.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `weight_profile_id` | معرّف ملف الأوزان | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `profile_code` | رمز الملف | text | نعم | - | - |
| `profile_name` | اسم الملف | text | نعم | - | - |
| `description` | وصف الملف | long_text | لا | - | - |
| `methodology` | المنهجية | long_text | لا | - | - |
| `is_active` | فعال | boolean | لا | - | - |
| `created_by` | المنشئ | text | لا | - | - |
| `approved_by` | المعتمد | text | لا | - | - |
| `approved_at` | تاريخ الاعتماد | datetime | لا | - | - |

#### `indicatorWeights` — أوزان المؤشرات

الجدول: `indicator_weights` · المفتاح الأساسي: `indicator_weight_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

وزن مؤشر داخل ملف أوزان محدد مع مبرره ومصدره.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `indicator_weight_id` | معرّف الوزن | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `weight_profile_id` | ملف الأوزان | reference | نعم | `indicator_weight_profiles.weight_profile_id` | - |
| `indicator_id` | المؤشر | reference | نعم | `indicator_definitions.id` | - |
| `weight_value` | قيمة الوزن | decimal | نعم | - | - |
| `rationale` | مبرر الوزن | long_text | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `indicatorTargets` — مستهدفات المؤشرات

الجدول: `indicator_targets` · المفتاح الأساسي: `indicator_target_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

القيمة المستهدفة للمؤشر بوحدة جغرافية وفترة ونوع مستهدف.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `indicator_target_id` | معرّف المستهدف | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `indicator_id` | المؤشر | reference | نعم | `indicator_definitions.id` | - |
| `geo_unit_id` | الوحدة الجغرافية | geo | لا | `geographic_units.geo_unit_id` | - |
| `period_id` | الفترة المرجعية | period | نعم | `periods.period_id` | - |
| `target_value` | القيمة المستهدفة | decimal | نعم | - | - |
| `unit_id` | وحدة القياس | unit | لا | `measurement_units.unit_id` | - |
| `target_type` | نوع المستهدف | text | لا | - | القيمة الافتراضية official؛ لا يوجد قيد CHECK على القيم. |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `notes` | ملاحظات | long_text | لا | - | - |

#### `indicatorBenchmarks` — قيم المؤشرات المرجعية

الجدول: `indicator_benchmarks` · المفتاح الأساسي: `benchmark_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

القيمة المرجعية للمؤشر حسب نوع الوحدة الجغرافية ونوع المرجع وفترة صلاحيته.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `benchmark_id` | معرّف القيمة المرجعية | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `indicator_id` | المؤشر | reference | نعم | `indicator_definitions.id` | - |
| `geography_type_id` | نوع الوحدة الجغرافية | reference | لا | `geo_unit_types.geo_unit_type_id` | - |
| `benchmark_type` | نوع المرجع | text | نعم | - | - |
| `value_number` | القيمة المرجعية | decimal | نعم | - | - |
| `unit_id` | وحدة القياس | unit | لا | `measurement_units.unit_id` | - |
| `valid_from` | ساري من | date | لا | - | - |
| `valid_to` | ساري إلى | date | لا | - | يجب ألا يسبق تاريخ السريان. |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |
| `rationale` | مبرر القيمة المرجعية | long_text | لا | - | - |

### 3.6 قاموس الحقول والأبعاد (`dictionary`)

#### `fieldGroups` — مجموعات الحقول الدلالية

الجدول: `field_groups` · المفتاح الأساسي: `group_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

هرمية المجال ثم المجال الفرعي ثم الفئة التي تُصنّف الحقول الدلالية.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `group_id` | معرّف المجموعة | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `group_code` | رمز المجموعة | text | نعم | - | - |
| `parent_group_id` | المجموعة الأعلى | reference | لا | `field_groups.group_id` | - |
| `group_level` | مستوى المجموعة | text | نعم | - | - |
| `name_ar` | الاسم العربي | text | نعم | - | - |
| `name_en` | الاسم الإنجليزي | text | لا | - | - |
| `description` | الوصف | long_text | لا | - | - |
| `sort_order` | ترتيب العرض | integer | لا | - | - |
| `is_active` | فعال | boolean | لا | - | - |

#### `fieldGroupFields` — حقول المجموعات الدلالية

الجدول: `field_group_fields` · المفتاح الأساسي: `group_id` · حالة القيمة: غير مستخدمة.

جدول ربط: أي تعريف حقل ينتمي إلى أي مجموعة دلالية وبأي ترتيب.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `group_id` | المجموعة الدلالية | reference | نعم | `field_groups.group_id` | - |
| `field_definition_id` | تعريف الحقل | reference | نعم | `field_definitions.field_definition_id` | - |
| `sort_order` | ترتيب العرض | integer | لا | - | - |
| `is_primary` | الانتماء الأساسي | boolean | لا | - | - |

#### `fieldDefinitionAliases` — أسماء الحقول البديلة

الجدول: `field_definition_aliases` · المفتاح الأساسي: `alias_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

الأسماء البديلة المعتمدة لتعريف الحقل ولغتها وطريقة مطابقتها ودرجة ثقتها.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `alias_id` | معرّف الاسم البديل | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `field_definition_id` | تعريف الحقل | reference | نعم | `field_definitions.field_definition_id` | - |
| `alias_text` | نص الاسم البديل | text | نعم | - | - |
| `normalized_alias` | الاسم البديل المطبع | text | نعم | - | - |
| `locale` | اللغة | text | لا | - | القيمة الافتراضية ar. |
| `is_approved` | معتمد | boolean | لا | - | - |
| `match_method` | طريقة المطابقة | text | لا | - | القيمة الافتراضية curated. |
| `confidence` | درجة الثقة | decimal | لا | - | - |
| `source_id` | المصدر | reference | لا | `data_sources.source_id` | - |

#### `fieldDimensionRules` — قواعد أبعاد الحقول

الجدول: `field_dimension_rules` · المفتاح الأساسي: `field_dimension_rule_id` (يُولَّد تلقائياً) · حالة القيمة: غير مستخدمة.

قواعد ربط تعريف الحقل بأبعاد التحليل وقيمها ودور المحور وإلزاميته.

| العمود | التسمية العربية | النوع | إلزامي | المرجع | ملاحظة |
|---|---|---|---|---|---|
| `field_dimension_rule_id` | معرّف القاعدة | integer | لا | - | المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج. |
| `field_definition_id` | تعريف الحقل | reference | نعم | `field_definitions.field_definition_id` | - |
| `dimension_id` | البعد التحليلي | reference | نعم | `dimension_definitions.dimension_id` | - |
| `dimension_value_id` | قيمة البعد | dimension | لا | `dimension_values.dimension_value_id` | - |
| `axis_role` | دور المحور | text | لا | - | القيمة الافتراضية breakdown؛ لا يوجد قيد CHECK على القيم. |
| `is_required` | إلزامي | boolean | لا | - | - |
| `sort_order` | ترتيب العرض | integer | لا | - | - |

## 4. قواعد النقد

| القاعدة | التنفيذ | الدليل |
|---|---|---|
| لا فقدان دقة | كل مبلغ يُخزَّن كـ REAL للتوافق و`*_minor` عدد صحيح 64 بت كمرجع حسابي | `unified-development-model-v2.cjs` → `MONEY_COLUMNS` |
| الخانة الدقيقة من سجل العملات | `minor = ROUND(value * 10^currencies.minor_unit)` بالبحث عن `currency_code` | `currencies` (`YER`=2، `USD`=2، `SAR`=2) |
| تطبيع العملة الفارغة | الرمز الفارغ أو المسافات يُطبَّع إلى `YER` قبل الحساب | `normaliseBlankCurrencyCodes` |
| رمز غير معروف | يُحسب بخانتين ويُسجَّل كمسألة جودة بدل الرفض الصامت | `detectUnknownCurrencies` |
| التقارير | `formatted` للمبالغ فقط، مع `minorUnit`؛ الأعداد ليست مبالغ | `finance-service.cjs` |

## 5. قواعد حالات القيمة

الحالات المعتمدة سبع، ومفروضة بقيود `CHECK` في `architecture-v1.sql` على `observations` و`record_field_values`:

`known` · `zero` · `not_available` · `unknown` · `not_applicable` · `not_collected` · `not_verified`

| الحالة | القيمة المخزنة إلزاماً | العرض في الواجهة |
|---|---|---|
| `known` | قيمة واحدة فقط من (integer/real/text/boolean/date/reference/entity) | الرقم أو النص |
| `zero` | قيمة عددية واحدة مساوية للصفر | `0` |
| `not_available` | لا قيمة | «غير متاح» |
| `unknown` | لا قيمة | «غير معروف» |
| `not_applicable` | لا قيمة | «لا ينطبق» |
| `not_collected` | لا قيمة | «لم يُجمع» |
| `not_verified` | لا قيمة | «لم يُتحقق» |

الفارغ يُعرض شرطة وليس صفراً في كل شاشات الطبقة الموحدة (`DomainRecords`, `DevelopmentAnalysis`, `PlanningExecution`, `FinanceBudget`).
