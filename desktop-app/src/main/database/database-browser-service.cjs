'use strict';

const domainService = require('./domain-service.cjs');
const { DATASETS } = require('./domain-registry.cjs');
const recordService = require('./record-service.cjs');
const manualEntryCatalog = require('./manual-entry-catalog.cjs');

const GROUP_DATASETS = Object.freeze({
  'population-households.households-and-housing': [],
  'poverty-livelihoods.poverty': ['householdWelfareRecords'],
  'target-groups-protection.assistance-and-social-protection': ['socialProtectionRecords'],
  'society-culture-heritage.cultural-heritage': ['culturalHeritageProfiles'],
  'crosscutting-documentation-quality.measurement-properties': ['fieldDimensionRules'],
  'education-literacy.enrollment-and-students': ['educationEnrollmentRecords'],
  'health-population-services.health-coverage': ['healthServiceRecords'],
  'natural-resources-environment.soil-and-land': [],
  'agriculture-irrigation-livestock-fisheries.livestock': ['livestockProductionRecords'],
  'agriculture-irrigation-livestock-fisheries.crops': ['agriculturalProductionRecords'],
  'agriculture-irrigation-livestock-fisheries.fisheries-and-fishing': ['fisheriesProductionRecords'],
  'industry-private-sector-tourism.commercial-and-service-establishments': ['economicEstablishments'],
  'industry-private-sector-tourism.tourism': ['tourismSiteProfiles'],
  'projects-finance-revenues.projects': [],
  'projects-finance-revenues.budgets-and-expenses': ['budgetHeaders', 'budgetLines', 'expenditureTransactions'],
  'projects-finance-revenues.revenues': ['revenueTransactions'],
  'development-indicators.indicator-definitions': ['indicatorDefinitionVersions'],
  'development-indicators.indicator-themes': ['indicatorComponents'],
  'development-indicators.targets': ['indicatorTargets', 'indicatorBenchmarks'],
  'development-analysis-priorities.swot': ['swotPestleAnalyses'],
  'development-analysis-priorities.development-issues': ['developmentIssues', 'developmentIssueFactors', 'developmentIssueEvidence'],
  'development-analysis-priorities.prioritization': ['priorityCriteria', 'issuePriorityAssessments', 'planPriorities'],
  'strategic-planning.objectives-and-outcomes': ['strategicObjectives'],
  'strategic-planning.programs-and-initiatives': ['developmentPrograms', 'programProjects'],
  'strategic-planning.monitoring': ['projectActivities', 'projectMilestones'],
  'crosscutting-documentation-quality.identifiers-and-classifications': ['fieldGroups', 'fieldGroupFields', 'fieldDefinitionAliases'],
});

const FORM_LEGACY_LINKS = Object.freeze({
  project_v1: Object.freeze({ table: 'projects', type: 'project', pk: 'id' }),
  project_funding_v1: Object.freeze({ table: 'project_funding', type: 'project_funding', pk: 'id' }),
  indicator_observation_v1: Object.freeze({ table: 'indicator_observations', type: 'indicator_observation', pk: 'id' }),
  legacy_directorate_v1: Object.freeze({ table: 'directorates', type: 'directorate', pk: 'id' }),
});
const LEGACY_TABLE_LINKS = Object.freeze(Object.fromEntries(Object.values(FORM_LEGACY_LINKS).map(link => [link.table, link])));

const OPERATIONAL_TABLES = Object.freeze({
  data_sources: 'مصادر البيانات وسجل المنشأ',
  import_batches: 'دفعات الاستيراد',
  import_sheets: 'أوراق الملفات المستوردة',
  import_regions: 'مناطق الاستيراد',
  import_rows: 'صفوف الاستيراد',
  import_cells: 'خلايا الاستيراد',
  import_field_mappings: 'مطابقات حقول الاستيراد',
  workbook_import_batches: 'ملفات Excel المستلمة',
  document_records: 'سجل الوثائق',
  managed_attachments: 'مرفقات محفوظة',
  data_quality_issues: 'ملاحظات جودة البيانات',
  audit_events: 'سجل التدقيق',
  access_log: 'سجل الوصول',
  read_access_log: 'سجل قراءات النظام',
  schema_migrations: 'إصدارات ترحيل قاعدة البيانات',
  development_model_migrations: 'إصدارات نموذج البيانات',
  application_migration_log: 'سجل ربط البيانات القديمة',
  form_records: 'السجلات المركزية',
  record_field_values: 'قيم حقول السجلات المركزية',
  observations: 'القياسات المركزية',
  value_provenance: 'توثيق مصادر القيم',
  record_revisions: 'تاريخ تغييرات السجلات',
  record_reviews: 'قرارات المراجعة',
  manual_entry_domains: 'كتالوج المجالات',
  manual_entry_groups: 'كتالوج المجموعات',
  manual_entry_group_forms: 'ربط النماذج بالمجموعات',
  entities: 'الكيانات المرجعية',
  geographic_units: 'الوحدات الجغرافية المرجعية',
  periods: 'الفترات المرجعية',
  reference_values: 'القيم المرجعية',
  dimension_definitions: 'تعريفات الأبعاد',
  dimension_values: 'قيم الأبعاد',
  field_definitions: 'تعريفات الحقول الدلالية',
  data_field_definitions: 'تعريفات الحقول القديمة',
  data_field_aliases: 'الأسماء البديلة للحقول القديمة',
  field_definition_aliases: 'الأسماء البديلة للحقول الدلالية',
  measurement_units: 'وحدات القياس',
  reference_sets: 'مجموعات القيم المرجعية',
  currencies: 'العملات',
  sectors: 'القطاعات المرجعية',
  entity_types: 'أنواع الكيانات',
  geo_unit_types: 'أنواع الوحدات الجغرافية',
  form_definitions: 'تعريفات النماذج',
  form_versions: 'إصدارات النماذج',
  form_sections: 'أقسام النماذج',
  form_fields: 'حقول النماذج',
  form_row_definitions: 'صفوف النماذج',
  form_field_aliases: 'أسماء حقول النماذج البديلة',
  manual_entry_form_governance: 'حوكمة النماذج اليدوية',
  manual_entry_form_field_governance: 'حوكمة حقول الإدخال',
  manual_entry_form_field_dimensions: 'أبعاد حقول النماذج',
  manual_entry_form_methodologies: 'منهجيات حقول النماذج',
  manual_entry_form_references: 'مراجع حقول النماذج',
  manual_entry_methodologies: 'سجل المنهجيات',
  manual_entry_reference_documents: 'المراجع والوثائق المنهجية',
  manual_entry_requirement_items: 'بنود مواصفة البيانات',
  manual_entry_group_field_candidates: 'مرشحو ربط حقول المجموعات',
  import_profiles: 'قواعد مطابقة ملفات الاستيراد',
  import_promotions: 'عمليات ترقية صفوف الاستيراد',
  import_row_decisions: 'قرارات مراجعة صفوف الاستيراد',
  import_validation_issues: 'ملاحظات تحقق الاستيراد',
  workbook_import_sheets: 'أوراق ملفات Excel',
  workbook_import_regions: 'نطاقات ملفات Excel',
  workbook_import_rows: 'صفوف ملفات Excel',
  workbook_import_promotions: 'عمليات ترقية ملفات Excel',
  normalized_import_promotions: 'ترقيات الاستيراد المعياري',
  workbook_import_media: 'مرفقات ملفات Excel',
  document_processing_runs: 'عمليات معالجة الوثائق',
  document_artifacts: 'مخرجات معالجة الوثائق',
  document_elements: 'عناصر الوثائق المستخرجة',
  document_ragflow_references: 'مراجع الوثائق المفهرسة',
  field_discovery_runs: 'عمليات اكتشاف الحقول',
  document_field_candidates: 'حقول مرشحة من الوثائق',
  document_candidate_promotions: 'ترقيات حقول الوثائق',
  indicator_calculation_runs: 'تشغيلات حساب المؤشرات',
  indicator_calculation_results: 'نتائج حساب المؤشرات',
  indicator_result_inputs: 'مدخلات نتائج المؤشرات',
  indicator_calculation_schema_migrations: 'إصدارات بنية حساب المؤشرات',
  indicator_definitions: 'تعريفات المؤشرات القديمة',
  indicator_observation_versions: 'تاريخ إصدارات قياسات المؤشرات',
  store_schema_migrations: 'إصدارات مخطط قاعدة البيانات',
  audit_reads: 'سجل قراءات البيانات',
  file_archive: 'سجل أرشفة العناصر',
  entity_records: 'ملفات الكيانات المركزية',
  entity_field_values: 'قيم حقول الكيانات المركزية',
  entity_identifiers: 'معرّفات الكيانات',
  entity_relationships: 'علاقات الكيانات',
  entity_record_versions: 'تاريخ تغييرات الكيانات',
  health_facilities: 'الملفات الوصفية للمرافق الصحية',
  schools: 'الملفات الوصفية للمدارس',
  organizations: 'الملفات الوصفية للمنظمات',
  road_segments: 'مقاطع الطرق',
  water_assets: 'أصول المياه',
  geographic_unit_aliases: 'الأسماء البديلة للوحدات الجغرافية',
  form_record_legacy_links: 'روابط السجلات المركزية والقديمة',
  observation_dimensions: 'أبعاد القياسات',
  directorate_sources: 'مصادر سجلات المديريات القديمة',
  directorate_versions: 'تاريخ سجلات المديريات القديمة',
  field_map: 'مطابقات الحقول القديمة',
  review_items: 'عناصر المراجعة القديمة',
  ocr_drafts: 'مسودات التعرف الضوئي',
  ocr_field_confidence: 'درجات ثقة حقول التعرف الضوئي',
  analysis_runs: 'تشغيلات التحليل القديمة',
  analysis_weights: 'أوزان التحليل القديمة',
  analysis_results: 'نتائج التحليل القديمة',
  analysis_calculation_run_links: 'روابط تشغيلات التحليل القديمة',
  analysis_calculation_result_links: 'روابط نتائج التحليل القديمة',
});

const OPERATIONAL_COLUMNS = Object.freeze({
  data_sources: [['source_id','معرّف المصدر'],['source_type','نوع المصدر'],['source_code','رمز المصدر'],['organization_name','الجهة'],['document_title','اسم الوثيقة'],['file_name','اسم الملف'],['content_sha256','بصمة المحتوى'],['received_at','تاريخ الاستلام'],['collected_at','تاريخ الجمع']],
  import_batches: [['batch_id','رقم الدفعة'],['batch_uuid','معرّف الدفعة'],['source_id','المصدر'],['batch_status','الحالة'],['parser_version','إصدار القارئ'],['mapping_version','إصدار المطابقة'],['created_by','أُنشئت بواسطة'],['started_at','بدء الاستيراد'],['completed_at','اكتمال الاستيراد'],['total_rows','الصفوف'],['accepted_rows','المقبولة'],['rejected_rows','المرفوضة'],['warning_rows','تحذيرات'],['failure_reason','سبب الفشل']],
  import_sheets: [['import_sheet_id','رقم الورقة'],['batch_id','دفعة الاستيراد'],['sheet_name','اسم الورقة'],['sheet_state','الحالة'],['max_row','عدد الصفوف'],['max_column','عدد الأعمدة'],['is_hidden','مخفية']],
  import_regions: [['import_region_id','رقم النطاق'],['import_sheet_id','الورقة'],['region_code','رمز النطاق'],['start_row','بداية الصف'],['end_row','نهاية الصف'],['match_status','حالة المطابقة'],['match_confidence','دقة المطابقة']],
  import_rows: [['import_row_id','رقم الصف'],['import_region_id','نطاق الاستيراد'],['source_row_number','صف المصدر'],['row_status','الحالة'],['has_formula','يحوي معادلة']],
  import_cells: [['import_cell_id','رقم الخلية'],['import_row_id','صف المصدر'],['cell_address','عنوان الخلية'],['source_header_text','عنوان المصدر'],['raw_value_type','نوع القيمة']],
  import_field_mappings: [['mapping_id','رقم المطابقة'],['source_header_text','عنوان المصدر'],['field_code','الحقل المعياري'],['match_status','الحالة'],['match_confidence','دقة المطابقة']],
  workbook_import_batches: [['id','رقم الملف'],['source_id','المصدر'],['file_name','اسم الملف'],['file_size','حجم الملف'],['sha256','بصمة الملف'],['sheet_count','الأوراق'],['row_count','الصفوف'],['cell_count','الخلايا'],['status','الحالة'],['created_at','تاريخ الإضافة']],
  document_records: [['document_id','رقم الوثيقة'],['source_id','المصدر'],['file_name','اسم الملف'],['mime_type','نوع الملف'],['document_status','الحالة'],['created_at','تاريخ الإضافة']],
  managed_attachments: [['id','رقم المرفق'],['entity_type','نوع العنصر'],['entity_id','العنصر المرتبط'],['source_id','المصدر'],['original_name','اسم الملف'],['mime_type','نوع الملف'],['extension','الامتداد'],['size_bytes','الحجم'],['sha256','بصمة الملف'],['classification','التصنيف'],['review_status','حالة المراجعة'],['created_at','تاريخ الإضافة']],
  data_quality_issues: [['issue_id','رقم الملاحظة'],['form_record_id','السجل'],['quality_code','رمز الجودة'],['severity','الخطورة'],['quality_status','الحالة'],['issue_message','التفاصيل'],['created_at','تاريخ الرصد']],
  audit_events: [['audit_event_id','رقم التدقيق'],['event_code','نوع الحدث'],['resource_type','نوع العنصر'],['resource_id','العنصر'],['action_type','العملية'],['performed_by','المنفذ'],['performed_at','التاريخ'],['details','التفاصيل']],
  access_log: [['id','رقم السجل'],['action','العملية'],['entity','نوع العنصر'],['entity_id','العنصر'],['detail','التفاصيل'],['created_at','التاريخ']],
  read_access_log: [['id','رقم السجل'],['channel','القناة'],['entity','نوع العنصر'],['entity_id','العنصر'],['row_count','عدد النتائج'],['created_at','التاريخ']],
  schema_migrations: [['version','الإصدار'],['migration_code','رمز الترحيل'],['migration_name','الترحيل'],['success','نجاح'],['applied_at','تاريخ التطبيق'],['details','التفاصيل']],
  development_model_migrations: [['version','الإصدار'],['migration_code','رمز الترحيل'],['migration_name','الترحيل'],['success','نجاح'],['applied_at','تاريخ التطبيق'],['details','التفاصيل']],
  application_migration_log: [['migration_code','رمز النقل'],['source_table','جدول المصدر'],['source_id','معرّف المصدر'],['target_table','الجدول المركزي'],['target_id','معرّف السجل'],['status','الحالة'],['details','التفاصيل'],['created_at','التاريخ']],
  form_records: [['form_record_id','رقم السجل'],['form_version_id','إصدار النموذج'],['geo_unit_id','الموقع'],['period_id','الفترة'],['record_label','اسم السجل'],['record_status','الحالة'],['revision_number','المراجعة'],['created_by','أُدخل بواسطة'],['updated_at','آخر تحديث'],['approved_at','تاريخ الاعتماد']],
  record_field_values: [['record_field_value_id','رقم القيمة'],['form_record_id','السجل'],['form_field_id','الحقل'],['value_text','القيمة النصية'],['value_boolean','نعم/لا'],['value_date','التاريخ'],['value_state','حالة القيمة']],
  observations: [['observation_id','رقم القياس'],['form_record_id','السجل'],['field_definition_id','تعريف الحقل'],['geo_unit_id','الموقع'],['period_id','الفترة'],['value_integer','القيمة الصحيحة'],['value_real','القيمة العشرية'],['value_text','القيمة النصية'],['value_state','حالة القيمة']],
  value_provenance: [['provenance_id','رقم التوثيق'],['observation_id','القياس'],['record_field_value_id','قيمة الحقل'],['source_id','المصدر'],['provenance_type','نوع التوثيق'],['source_locator','موضع المصدر'],['original_value_text','القيمة الأصلية'],['normalized_value_text','القيمة المعيارية'],['entered_by','أُدخلت بواسطة'],['created_at','التاريخ']],
  record_revisions: [['record_revision_id','رقم المراجعة'],['form_record_id','السجل'],['revision_number','الإصدار'],['action_type','العملية'],['change_reason','السبب'],['changed_by','المنفذ'],['created_at','التاريخ']],
  record_reviews: [['record_review_id','رقم المراجعة'],['form_record_id','السجل'],['review_stage','المرحلة'],['decision','القرار'],['reviewer_id','المراجع'],['decision_reason','السبب'],['reviewed_at','التاريخ']],
  manual_entry_domains: [['domain_id','رقم المجال'],['domain_code','رمز المجال'],['name_ar','اسم المجال'],['sort_order','الترتيب'],['definition_state','حالة التعريف']],
  manual_entry_groups: [['group_id','رقم المجموعة'],['group_code','رمز المجموعة'],['name_ar','اسم المجموعة'],['sort_order','الترتيب'],['definition_state','حالة التعريف']],
  manual_entry_group_forms: [['group_id','المجموعة'],['form_code','رمز النموذج'],['coverage_note','حدود التغطية']],
  entities: [['entity_id','رقم الكيان'],['canonical_code','الرمز'],['name_ar','الاسم'],['entity_type_id','نوع الكيان'],['geo_unit_id','الموقع'],['is_active','نشط']],
  geographic_units: [['geo_unit_id','رقم الوحدة'],['official_code','الرمز الرسمي'],['name_ar','اسم الوحدة'],['parent_geo_unit_id','الوحدة الأم'],['is_active','نشطة']],
  periods: [['period_id','رقم الفترة'],['period_code','الرمز'],['period_type','النوع'],['label_ar','اسم الفترة'],['start_date','البداية'],['end_date','النهاية'],['is_active','نشطة']],
  reference_values: [['reference_value_id','رقم القيمة'],['reference_set_id','مجموعة المرجع'],['value_code','الرمز'],['label_ar','التسمية'],['is_active','نشطة']],
  dimension_definitions: [['dimension_id','رقم البعد'],['dimension_code','رمز البعد'],['name_ar','اسم البعد'],['is_active','نشط']],
  dimension_values: [['dimension_value_id','رقم القيمة'],['dimension_id','البعد'],['value_code','الرمز'],['label_ar','التسمية'],['is_active','نشطة']],
  field_definitions: [['field_definition_id','معرّف الحقل'],['field_code','رمز الحقل'],['canonical_name_ar','الاسم المعياري'],['semantic_type','النوع الدلالي'],['data_type','نوع البيانات'],['default_unit_id','وحدة القياس'],['reference_set_id','مجموعة المرجع'],['is_derived','مشتق'],['is_direct_entry','قابل للإدخال'],['is_required','إلزامي'],['is_active','نشط'],['specification_version','إصدار المواصفة']],
  data_field_definitions: [['id','معرّف الحقل'],['entity_type','نوع الكيان'],['field_key','رمز الحقل'],['label_ar','التسمية'],['data_type','نوع البيانات'],['unit','الوحدة المسجلة'],['sensitivity','الحساسية'],['field_class','التصنيف'],['temporal_behavior','السلوك الزمني'],['active','نشط']],
  data_field_aliases: [['id','معرّف الاسم البديل'],['field_definition_id','تعريف الحقل'],['alias','الاسم البديل'],['locale','اللغة'],['confidence','الثقة'],['approved','معتمد']],
  field_definition_aliases: [['alias_id','معرّف الاسم البديل'],['field_definition_id','تعريف الحقل'],['alias_text','الاسم البديل'],['locale','اللغة'],['is_approved','معتمد']],
  measurement_units: [['unit_id','معرّف الوحدة'],['unit_code','رمز الوحدة'],['name_ar','اسم الوحدة'],['name_en','الاسم الإنجليزي'],['symbol','الرمز المختصر'],['unit_category','فئة الوحدة'],['base_unit_id','الوحدة الأساسية'],['conversion_factor','معامل التحويل'],['is_active','نشطة']],
  reference_sets: [['reference_set_id','معرّف المجموعة'],['set_code','رمز المجموعة'],['name_ar','الاسم العربي'],['name_en','الاسم الإنجليزي'],['is_hierarchical','هرمية'],['is_active','نشطة']],
  currencies: [['currency_code','رمز العملة'],['name_ar','اسم العملة'],['name_en','الاسم الإنجليزي'],['minor_unit','الوحدة الصغرى'],['symbol','رمز العرض'],['is_active','نشطة']],
  sectors: [['sector_id','معرّف القطاع'],['sector_code','رمز القطاع'],['name_ar','اسم القطاع'],['name_en','الاسم الإنجليزي'],['parent_sector_id','القطاع الأم'],['is_active','نشط']],
  entity_types: [['entity_type_id','معرّف النوع'],['entity_type_code','رمز النوع'],['name_ar','اسم النوع'],['name_en','الاسم الإنجليزي'],['is_active','نشط']],
  geo_unit_types: [['geo_unit_type_id','معرّف النوع'],['type_code','رمز النوع'],['name_ar','اسم النوع'],['name_en','الاسم الإنجليزي'],['parent_type_id','النوع الأعلى'],['level_order','ترتيب المستوى']],
  form_definitions: [['form_id','معرّف النموذج'],['form_code','رمز النموذج'],['name_ar','اسم النموذج'],['name_en','الاسم الإنجليزي'],['data_structure_type','نوع البنية'],['default_period_type','نوع الفترة الافتراضي'],['is_active','نشط']],
  form_versions: [['form_version_id','معرّف الإصدار'],['form_id','النموذج'],['version_number','رقم الإصدار'],['version_label','اسم الإصدار'],['status','الحالة'],['effective_from','ساري من'],['effective_to','ساري حتى'],['published_at','تاريخ النشر']],
  form_sections: [['section_id','معرّف القسم'],['form_version_id','إصدار النموذج'],['section_code','رمز القسم'],['name_ar','اسم القسم'],['section_type','نوع القسم'],['sort_order','الترتيب'],['is_repeatable','متكرر'],['is_required','إلزامي']],
  form_fields: [['form_field_id','معرّف الحقل'],['form_version_id','إصدار النموذج'],['section_id','القسم'],['field_code','رمز الحقل'],['label_ar','التسمية'],['data_type_override','نوع البيانات'],['storage_class','طريقة التخزين'],['is_required','إلزامي'],['is_repeatable','متكرر'],['is_derived','مشتق'],['is_importable','قابل للاستيراد'],['unit_id','وحدة القياس'],['sort_order','الترتيب']],
  form_row_definitions: [['row_definition_id','معرّف الصف'],['form_version_id','إصدار النموذج'],['row_code','رمز الصف'],['label_ar','التسمية'],['row_type','نوع الصف'],['dimension_id','البعد'],['dimension_value_id','قيمة البعد'],['is_total_row','صف إجمالي'],['is_input_row','صف إدخال'],['sort_order','الترتيب']],
  form_field_aliases: [['field_alias_id','معرّف الاسم البديل'],['form_field_id','حقل النموذج'],['alias_text','الاسم البديل'],['locale','اللغة'],['match_method','طريقة المطابقة'],['confidence','درجة المطابقة'],['is_approved','معتمد']],
  manual_entry_form_governance: [['form_version_id','إصدار النموذج'],['collection_mode','نمط الجمع'],['definition_status','حالة التعريف'],['methodology_status','حالة المنهجية'],['reference_status','حالة المرجع'],['analysis_eligible','مؤهل للتحليل'],['updated_at','آخر تحديث']],
  manual_entry_form_field_governance: [['form_field_id','حقل النموذج'],['definition_status','حالة التعريف'],['unit_status','حالة الوحدة'],['methodology_status','حالة المنهجية'],['analysis_eligible','مؤهل للتحليل'],['updated_at','آخر تحديث']],
  manual_entry_form_field_dimensions: [['form_field_id','حقل النموذج'],['dimension_id','البعد'],['is_required','إلزامي'],['sort_order','الترتيب']],
  manual_entry_form_methodologies: [['form_version_id','إصدار النموذج'],['form_field_id','حقل النموذج'],['methodology_id','المنهجية']],
  manual_entry_form_references: [['form_version_id','إصدار النموذج'],['form_field_id','حقل النموذج'],['reference_document_id','المرجع'],['source_clause','موضع الاستشهاد']],
  manual_entry_methodologies: [['methodology_id','معرّف المنهجية'],['methodology_code','رمز المنهجية'],['version_number','الإصدار'],['name_ar','اسم المنهجية'],['methodology_status','الحالة'],['unit_code','رمز الوحدة'],['effective_from','ساري من'],['effective_to','ساري حتى']],
  manual_entry_reference_documents: [['reference_document_id','معرّف المرجع'],['reference_code','رمز المرجع'],['version_number','الإصدار'],['title','العنوان'],['issuing_authority','الجهة المصدرة'],['reference_status','الحالة']],
  manual_entry_requirement_items: [['requirement_item_id','معرّف البند'],['item_code','رمز البند'],['group_id','المجموعة'],['item_order','الترتيب'],['semantic_class','التصنيف الدلالي'],['classification_state','حالة التصنيف'],['field_definition_id','تعريف الحقل'],['specification_version','إصدار المواصفة']],
  manual_entry_group_field_candidates: [['group_id','المجموعة'],['field_definition_id','تعريف الحقل'],['source_group_code','رمز المجموعة المصدر'],['mapping_state','حالة الربط'],['created_at','تاريخ الإضافة']],
  import_profiles: [['import_profile_id','معرّف القاعدة'],['profile_code','رمز القاعدة'],['profile_name','اسم القاعدة'],['form_version_id','إصدار النموذج'],['profile_version','الإصدار'],['is_active','نشط'],['created_at','تاريخ الإضافة']],
  import_promotions: [['promotion_id','معرّف الترقية'],['import_row_id','صف الاستيراد'],['form_record_id','السجل المركزي'],['promoted_by','المنفذ'],['promoted_at','التاريخ'],['promotion_status','الحالة']],
  import_row_decisions: [['row_decision_id','معرّف القرار'],['import_row_id','صف الاستيراد'],['decision','القرار'],['decided_by','متخذ القرار'],['decided_at','التاريخ']],
  import_validation_issues: [['validation_issue_id','معرّف الملاحظة'],['batch_id','دفعة الاستيراد'],['import_row_id','صف الاستيراد'],['issue_code','الرمز'],['severity','الخطورة'],['is_resolved','محلولة'],['created_at','تاريخ الرصد']],
  workbook_import_sheets: [['id','معرّف الورقة'],['batch_id','دفعة الاستيراد'],['sheet_index','ترتيب الورقة'],['name','اسم الورقة'],['state','الحالة'],['max_row','الصفوف'],['max_column','الأعمدة'],['cell_count','الخلايا'],['formula_count','المعادلات'],['truncated','مقتطعة']],
  workbook_import_regions: [['id','معرّف النطاق'],['batch_id','دفعة الاستيراد'],['sheet_id','الورقة'],['region_index','ترتيب النطاق'],['first_data_row','أول صف بيانات'],['last_data_row','آخر صف بيانات'],['candidate_type','نوع البيانات المرشح'],['confidence','الثقة'],['review_status','حالة المراجعة']],
  workbook_import_rows: [['id','معرّف الصف'],['batch_id','دفعة الاستيراد'],['sheet_id','الورقة'],['row_number','رقم الصف'],['is_hidden','مخفي'],['cell_count','الخلايا'],['has_formula','يحوي معادلة']],
  workbook_import_promotions: [['id','معرّف الترقية'],['batch_id','دفعة الاستيراد'],['region_id','النطاق'],['row_id','الصف'],['entity_type','نوع الكيان'],['target_id','الهدف'],['source_location','موضع المصدر'],['created_at','التاريخ']],
  workbook_import_media: [['id','معرّف المرفق'],['batch_id','دفعة الاستيراد'],['sheet_id','الورقة'],['media_index','ترتيب المرفق'],['original_name','اسم الملف'],['extension','الامتداد'],['mime_type','نوع الملف'],['size_bytes','الحجم'],['sha256','بصمة الملف'],['extraction_status','حالة الاستخراج']],
  document_processing_runs: [['id','معرّف العملية'],['document_id','الوثيقة'],['engine_name','محرك المعالجة'],['engine_version','إصدار المحرك'],['status','الحالة'],['started_at','بدء المعالجة'],['completed_at','اكتمال المعالجة']],
  document_artifacts: [['id','معرّف المخرج'],['document_id','الوثيقة'],['artifact_type','نوع المخرج'],['created_at','تاريخ الإنشاء']],
  document_elements: [['id','معرّف العنصر'],['document_id','الوثيقة'],['sequence_number','ترتيب العنصر'],['element_type','نوع العنصر'],['heading','العنوان'],['page_number','الصفحة'],['confidence','الثقة']],
  document_ragflow_references: [['id','معرّف المرجع'],['document_id','الوثيقة'],['dataset_id','مجموعة البحث'],['ragflow_document_id','معرّف الوثيقة المفهرسة'],['status','الحالة'],['updated_at','آخر تحديث']],
  field_discovery_runs: [['id','معرّف العملية'],['status','الحالة'],['field_count','الحقول'],['searched_count','المفحوصة'],['evidence_count','الأدلة'],['started_at','بدء العملية'],['completed_at','اكتمال العملية']],
  document_field_candidates: [['id','معرّف المرشح'],['field_code','رمز الحقل'],['field_label_ar','اسم الحقل'],['data_type','نوع البيانات'],['source_document_id','الوثيقة'],['source_file_name','اسم المصدر'],['page_number','الصفحة'],['confidence','الثقة'],['validation_status','التحقق'],['review_status','المراجعة'],['created_at','تاريخ الإضافة']],
  document_candidate_promotions: [['candidate_id','المرشح'],['form_record_id','السجل المركزي'],['form_field_id','حقل النموذج'],['promoted_by','المنفذ'],['promoted_at','التاريخ']],
  indicator_calculation_runs: [['calculation_run_id','معرّف التشغيل'],['weight_profile_id','ملف الأوزان'],['period_id','الفترة'],['run_mode','النمط'],['algorithm_version','إصدار الخوارزمية'],['input_snapshot_hash','بصمة المدخلات'],['started_by','المنفذ'],['started_at','البدء'],['completed_at','الاكتمال'],['run_status','الحالة']],
  indicator_calculation_results: [['calculation_result_id','معرّف النتيجة'],['calculation_run_id','التشغيل'],['indicator_id','المؤشر'],['geo_unit_id','الموقع'],['raw_value','القيمة الخام'],['normalized_value','القيمة المعيارية'],['weighted_value','القيمة الموزونة'],['composite_score','النتيجة المركبة'],['rank_value','الترتيب'],['confidence_level','الثقة'],['coverage_ratio','التغطية'],['created_at','تاريخ الإنشاء']],
  indicator_result_inputs: [['result_input_id','معرّف المدخل'],['calculation_result_id','النتيجة'],['observation_id','القياس'],['input_role','دور المدخل'],['input_value','القيمة العددية'],['input_state','حالة القيمة'],['source_id','المصدر'],['created_at','تاريخ الإضافة']],
  indicator_calculation_schema_migrations: [['version','الإصدار'],['migration_code','رمز الترحيل'],['applied_at','تاريخ التطبيق'],['success','نجاح']],
  indicator_definitions: [['id','معرّف المؤشر'],['code','رمز المؤشر'],['label_ar','اسم المؤشر'],['sector_id','القطاع'],['unit','الوحدة'],['direction','اتجاه المؤشر'],['active','نشط'],['updated_at','آخر تحديث']],
  indicator_observation_versions: [['id','معرّف النسخة'],['observation_id','القياس'],['action','العملية'],['source_id','المصدر'],['created_at','تاريخ الإنشاء']],
  store_schema_migrations: [['version','الإصدار'],['migration_code','رمز الترحيل'],['applied_at','تاريخ التطبيق'],['execution_ms','مدة التنفيذ'],['success','نجاح']],
  audit_reads: [['id','معرّف القراءة'],['channel','القناة'],['entity','العنصر'],['entity_id','معرّف العنصر'],['result','النتيجة'],['row_count','عدد النتائج'],['created_at','التاريخ']],
  file_archive: [['resource_type','نوع العنصر'],['resource_id','معرّف العنصر'],['archived_at','تاريخ الأرشفة'],['archived_by','أرشف بواسطة']],
  entity_records: [['id','معرّف الكيان'],['entity_type','نوع الكيان'],['geographic_unit_id','الوحدة الجغرافية'],['sector_id','القطاع'],['external_key','المعرف الخارجي'],['status','الحالة'],['created_at','تاريخ الإضافة'],['updated_at','آخر تحديث']],
  entity_field_values: [['id','معرّف القيمة'],['record_id','الكيان'],['field_definition_id','تعريف الحقل'],['period_key','الفترة'],['value_text','القيمة النصية'],['value_number','القيمة العددية'],['value_date','التاريخ'],['value_boolean','نعم/لا'],['value_state','حالة القيمة'],['source_id','المصدر'],['source_location','موضع المصدر'],['created_at','تاريخ الإضافة'],['updated_at','آخر تحديث']],
  entity_identifiers: [['entity_identifier_id','معرّف الهوية'],['entity_id','الكيان'],['identifier_type','نوع المعرّف'],['identifier_value','قيمة المعرّف'],['issuing_authority','الجهة المصدرة'],['valid_from','ساري من'],['valid_to','ساري حتى'],['source_id','المصدر']],
  entity_relationships: [['relationship_id','معرّف العلاقة'],['from_entity_id','الكيان الأول'],['to_entity_id','الكيان الثاني'],['relationship_type','نوع العلاقة'],['valid_from','ساري من'],['valid_to','ساري حتى'],['source_id','المصدر'],['created_at','تاريخ الإضافة']],
  entity_record_versions: [['id','معرّف النسخة'],['record_id','الكيان'],['action','العملية'],['created_at','تاريخ الإنشاء']],
  health_facilities: [['entity_id','معرّف الكيان'],['facility_code','رمز المرفق'],['facility_type_id','نوع المرفق'],['ownership_type_id','الملكية'],['service_level_id','مستوى الخدمة'],['established_date','تاريخ الإنشاء'],['operational_status_id','الحالة التشغيلية'],['bed_capacity','سعة الأسرة'],['created_at','تاريخ الإضافة'],['updated_at','آخر تحديث']],
  schools: [['entity_id','معرّف الكيان'],['school_code','رمز المدرسة'],['school_type_id','نوع المدرسة'],['gender_mode_id','نمط الجنس'],['education_level_id','المرحلة التعليمية'],['ownership_type_id','الملكية'],['building_type_id','نوع المبنى'],['building_condition_id','حالة المبنى'],['established_date','تاريخ الإنشاء'],['is_active','نشطة'],['created_at','تاريخ الإضافة'],['updated_at','آخر تحديث']],
  organizations: [['entity_id','معرّف الكيان'],['organization_type_id','نوع المنظمة'],['registration_code','رمز التسجيل'],['established_date','تاريخ الإنشاء'],['legal_status_id','الحالة القانونية'],['created_at','تاريخ الإضافة'],['updated_at','آخر تحديث']],
  road_segments: [['road_segment_id','معرّف المقطع'],['entity_id','الكيان'],['road_code','رمز الطريق'],['start_geo_unit_id','نقطة البداية'],['end_geo_unit_id','نقطة النهاية'],['surface_type_id','نوع السطح'],['road_class_id','تصنيف الطريق'],['condition_id','الحالة'],['length_km','الطول بالكيلومتر'],['beneficiary_population','السكان المستفيدون'],['created_at','تاريخ الإضافة'],['updated_at','آخر تحديث']],
  water_assets: [['entity_id','معرّف الأصل'],['asset_code','رمز الأصل'],['asset_type_id','نوع الأصل'],['ownership_type_id','الملكية'],['capacity_value','السعة'],['capacity_unit_id','وحدة السعة'],['operational_status_id','الحالة التشغيلية'],['established_date','تاريخ الإنشاء'],['created_at','تاريخ الإضافة'],['updated_at','آخر تحديث']],
  directorate_sources: [['id','معرّف المصدر'],['directorate_id','سجل المديرية'],['field_key','الحقل'],['source_file','ملف المصدر'],['source_location','موضع المصدر'],['data_value_id','قيمة البيانات'],['captured_at','تاريخ الالتقاط']],
  directorate_versions: [['id','معرّف النسخة'],['directorate_id','سجل المديرية'],['action','العملية'],['created_at','تاريخ الإنشاء']],
  field_map: [['id','معرّف المطابقة'],['source_label','اسم المصدر'],['normalized','الاسم الموحد'],['field_key','الحقل'],['method','الطريقة'],['confidence','الثقة'],['updated_at','آخر تحديث']],
  review_items: [['id','معرّف العنصر'],['batch_id','دفعة الاستيراد'],['field_name','الحقل'],['proposed_type','النوع المقترح'],['governorate','المحافظة'],['district','المديرية'],['record_id','السجل'],['source_location','موضع المصدر'],['confidence','الثقة'],['status','الحالة'],['created_at','تاريخ الإنشاء'],['reviewed_at','تاريخ المراجعة']],
  ocr_drafts: [['id','معرّف المسودة'],['file_name','اسم الملف'],['file_type','نوع الملف'],['file_size','الحجم'],['confidence','الثقة'],['status','الحالة'],['created_at','تاريخ الإنشاء'],['updated_at','آخر تحديث']],
  ocr_field_confidence: [['id','معرّف التقدير'],['draft_id','المسودة'],['field_key','الحقل'],['header','العنوان'],['engine_confidence','ثقة المحرك'],['header_score','ثقة العنوان'],['decision','القرار'],['created_at','تاريخ الإنشاء']],
  analysis_runs: [['id','معرّف التشغيل'],['mode','النمط'],['k_threshold','حد ك'],['deprivation_line','خط الحرمان'],['row_count','عدد السجلات'],['template_file','ملف القالب'],['template_sheet','ورقة القالب'],['created_at','التاريخ']],
  analysis_weights: [['id','معرّف الأوزان'],['name','الاسم'],['note','الملاحظة'],['active','نشط'],['created_at','تاريخ الإنشاء']],
  analysis_results: [['id','معرّف النتيجة'],['run_id','التشغيل'],['district','المديرية'],['governorate','المحافظة'],['completeness','الاكتمال'],['replica_composite','النتيجة المركبة'],['replica_rank','الترتيب'],['calibrated_composite','النتيجة المعايرة'],['calibrated_rank','الترتيب المعاير'],['confidence_level','الثقة'],['project_type','نوع المشروع']],
  analysis_calculation_run_links: [['legacy_analysis_run_id','تشغيل التحليل القديم'],['calculation_run_id','تشغيل الحساب'],['run_mode','النمط'],['created_at','التاريخ']],
  analysis_calculation_result_links: [['legacy_analysis_result_id','نتيجة التحليل القديمة'],['calculation_result_id','نتيجة الحساب'],['run_mode','النمط'],['created_at','التاريخ']],
  geographic_unit_aliases: [['alias_id','معرّف الاسم البديل'],['geo_unit_id','الوحدة الجغرافية'],['alias_text','الاسم البديل'],['locale','اللغة'],['alias_type','نوع الاسم'],['is_approved','معتمد'],['source_id','المصدر'],['created_at','تاريخ الإضافة']],
  form_record_legacy_links: [['form_record_id','السجل المركزي'],['legacy_entity_type','نوع السجل القديم'],['legacy_entity_id','السجل القديم'],['linked_at','تاريخ الربط']],
  observation_dimensions: [['observation_dimension_id','معرّف الربط'],['observation_id','القياس'],['dimension_id','البعد'],['dimension_value_id','قيمة البعد'],['created_at','تاريخ الإضافة']],
  normalized_import_promotions: [['normalized_promotion_id','معرّف الترقية'],['import_row_id','صف الاستيراد'],['target_entity_type','نوع الكيان'],['target_entity_id','الكيان الهدف'],['form_record_id','السجل المركزي'],['source_location','موضع المصدر'],['promotion_status','الحالة'],['promoted_by','المنفذ'],['promoted_at','التاريخ']],
});

const LEGACY_TABLE_FIELDS = Object.freeze({
  projects: [['id','رقم المشروع'],['code','رمز المشروع'],['name','اسم المشروع'],['status','الحالة'],['geographic_unit_id','الموقع'],['sector_id','القطاع'],['estimated_cost','التكلفة التقديرية'],['actual_cost','التكلفة الفعلية'],['currency_code','العملة'],['start_date','تاريخ البداية'],['end_date','تاريخ النهاية'],['source_id','المصدر'],['created_at','تاريخ الإنشاء'],['updated_at','آخر تحديث']],
  project_funding: [['id','رقم التمويل'],['project_id','المشروع'],['partner_name','الجهة الممولة'],['amount','المبلغ'],['currency_code','العملة'],['funding_date','تاريخ التمويل'],['source_id','المصدر'],['created_at','تاريخ الإنشاء']],
  indicator_observations: [['id','رقم القياس'],['indicator_id','المؤشر'],['geographic_unit_id','الموقع'],['period_key','الفترة'],['value_number','القيمة العددية'],['value_text','القيمة النصية'],['value_state','حالة القيمة'],['source_id','المصدر'],['created_at','تاريخ الإنشاء']],
  directorates: [['id','رقم السجل'],['governorate','المحافظة'],['district','المديرية'],['nature','الطبيعة'],['population','السكان'],['schools','المدارس'],['enrolled_students','الطلاب'],['water_coverage','تغطية المياه'],['paved_roads','الطرق المعبدة'],['revenue','الإيرادات'],['project_cost','تكلفة المشاريع'],['project_status','حالة المشاريع'],['source_file','ملف المصدر'],['source_sheet','ورقة المصدر'],['source_row','صف المصدر'],['updated_at','آخر تحديث']],
  data_values: [['id','معرّف القيمة'],['governorate','المحافظة'],['district','المديرية'],['subdistrict','المديرية الفرعية'],['settlement','التجمع'],['record_type','نوع السجل'],['record_id','السجل المصدر'],['field_name','الحقل المصدر'],['value_text','القيمة الخام'],['source_file','ملف المصدر'],['source_location','موضع المصدر'],['imported_at','تاريخ الاستيراد']],
});

const UNCLASSIFIED_TABLE_LABELS = Object.freeze({ data_values: 'قيم بيانات قديمة غير مرتبطة بسجل مركزي' });

const COUNT_ONLY_TABLES = Object.freeze({
  app_settings: { labelAr: 'إعدادات النظام المحفوظة', reason: 'قد تحتوي قيماً تشغيلية أو مفاتيح؛ لا تُعرض الخلايا.' },
  project_versions: { labelAr: 'تاريخ إصدارات المشاريع القديم', reason: 'يحوي لقطات JSON كاملة؛ يلزم مسار مراجعة متخصص قبل عرضها.' },
});

const SOURCE_LABELS = Object.freeze({
  manual_entry: 'إدخال يدوي موثق',
  'excel-workbook': 'ملف Excel',
  'legacy-compatibility': 'سجل قديم — مصدر غير موثق',
  legacy_import: 'استيراد قديم — الملف الأصلي غير متاح',
  document: 'وثيقة',
  'manual-indicator-observation': 'إدخال يدوي لقياس',
  manual: 'إدخال يدوي',
  'manual-funding': 'إدخال تمويل يدوي',
});

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_LIMIT = 200;

function quote(name) {
  const text = String(name ?? '');
  if (!IDENTIFIER.test(text)) throw new Error('اسم الجدول غير صالح.');
  return `"${text}"`;
}

function tablePresent(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function tableColumns(db, name) {
  return tablePresent(db, name) ? db.prepare(`PRAGMA table_info(${quote(name)})`).all() : [];
}

function rowCount(db, name) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get().count ?? 0);
}

function tableStats(db, table) {
  if (!tablePresent(db, table)) return { count: 0, latestUpdatedAt: null };
  const columns = new Set(tableColumns(db, table).map(column => column.name));
  const latestColumn = ['updated_at', 'created_at', 'received_at', 'performed_at'].find(column => columns.has(column));
  const count = rowCount(db, table);
  const latestUpdatedAt = latestColumn
    ? db.prepare(`SELECT MAX(${quote(latestColumn)}) AS latest FROM ${quote(table)}`).get().latest ?? null
    : null;
  return { count, latestUpdatedAt };
}

function catalogIndex(catalog) {
  const groups = new Map();
  for (const domain of catalog.domains) {
    for (const group of domain.groups) groups.set(group.code, { domain, group });
  }
  return groups;
}

function approvedDatasetStats(db, key, listed) {
  const definition = DATASETS[key];
  if (!definition || !listed?.available || !tablePresent(db, definition.table)) return { count: 0, pendingCount: 0, latestUpdatedAt: null };
  const description = domainService.describe(db, key);
  const statusField = description.fields.find(field => ['approval_status','review_status','record_status'].includes(field.name));
  if (!statusField) return { count: 0, pendingCount: Number(listed.count ?? 0), latestUpdatedAt: null, approvalUnavailable: true };
  const columns = new Set(description.fields.map(field => field.name));
  const dateField = ['updated_at','created_at'].find(field => columns.has(field));
  const row = db.prepare(`SELECT SUM(CASE WHEN ${quote(statusField.name)}='approved' THEN 1 ELSE 0 END) AS approved,
    SUM(CASE WHEN ${quote(statusField.name)}<>'approved' OR ${quote(statusField.name)} IS NULL THEN 1 ELSE 0 END) AS pending,
    ${dateField ? `MAX(CASE WHEN ${quote(statusField.name)}='approved' THEN ${quote(dateField)} END)` : 'NULL'} AS latest
    FROM ${quote(definition.table)}`).get();
  return { count: Number(row.approved ?? 0), pendingCount: Number(row.pending ?? 0), latestUpdatedAt: row.latest ?? null, approvalUnavailable: false };
}

function formCounts(db, group) {
  if (!group.forms.length || !tablePresent(db, 'form_records')) return { count: 0, latestUpdatedAt: null, duplicates: 0 };
  const formCodes = [...new Set(group.forms.map(form => form.code))];
  const placeholders = formCodes.map(() => '?').join(',');
  const counts = db.prepare(`SELECT COUNT(*) AS count,MAX(record.updated_at) AS latest
    FROM form_records record JOIN form_versions version USING(form_version_id)
    JOIN form_definitions form USING(form_id) WHERE form.form_code IN (${placeholders}) AND version.status='published' AND record.record_status='approved'`).get(...formCodes);
  let duplicates = 0;
  for (const code of formCodes) {
    const compatibility = FORM_LEGACY_LINKS[code];
    if (!compatibility || !tablePresent(db, compatibility.table) || !tablePresent(db, 'form_record_legacy_links')) continue;
    duplicates += Number(db.prepare(`SELECT COUNT(DISTINCT record.form_record_id) AS count FROM form_records record
      JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
      JOIN form_record_legacy_links link ON link.form_record_id=record.form_record_id
      WHERE form.form_code=? AND version.status='published' AND link.legacy_entity_type=?`)
      .get(code, compatibility.type).count ?? 0);
  }
  return { count: Number(counts?.count ?? 0), latestUpdatedAt: counts?.latest ?? null, duplicates };
}

function getOverview(db) {
  const catalog = manualEntryCatalog.listCatalog(db);
  const typedDatasets = domainService.listDatasets(db);
  const datasetsByKey = new Map(typedDatasets.map(dataset => [dataset.key, dataset]));
  const groupsByCode = catalogIndex(catalog);
  const mappedKeys = new Set(Object.values(GROUP_DATASETS).flat());
  const groupSummaries = new Map();

  for (const [code, { group }] of groupsByCode) {
    const datasetKeys = GROUP_DATASETS[code] ?? [];
    const datasets = datasetKeys.map(key => {
      const definition = DATASETS[key];
      const listed = datasetsByKey.get(key);
      if (!definition || !listed) return null;
      const stats = approvedDatasetStats(db, key, listed);
      return { ...listed, rawCount: Number(listed.count ?? 0), ...stats };
    }).filter(Boolean);
    const forms = formCounts(db, group);
    const tableRecords = datasets.reduce((sum, item) => sum + item.count, 0);
    const pendingDatasetRecords = datasets.reduce((sum, item) => sum + item.pendingCount, 0);
    const count = tableRecords + forms.count;
    const latestUpdatedAt = [...datasets.map(item => item.latestUpdatedAt), forms.latestUpdatedAt].filter(Boolean).sort().at(-1) ?? null;
    const hasStorage = datasets.length > 0 || group.forms.length > 0;
    const state = !hasStorage ? 'unlinked' : count ? 'filled' : pendingDatasetRecords ? 'awaiting_approval' : 'empty';
    groupSummaries.set(code, {
      code,
      name: group.name,
      order: group.order,
      definitionState: group.definitionState,
      fieldCoverageState: group.fieldCoverageState,
      state,
      count,
      latestUpdatedAt,
      datasets,
      forms: group.forms.map(form => ({ ...form, count: formCountsForCode(db, form.code) })),
      sources: [
        ...datasets.map(dataset => ({ key: `dataset:${dataset.key}`, type: 'dataset', label: dataset.labelAr, count: dataset.count,
          pendingCount: dataset.pendingCount, approvalUnavailable: dataset.approvalUnavailable, latestUpdatedAt: dataset.latestUpdatedAt, datasetKey: dataset.key })),
        ...group.forms.map(form => ({ key: `form:${form.versionId}`, type: 'form', label: form.name, count: formCountsForCode(db, form.code),
          formVersionId: form.versionId, formCode: form.code, rawCaptureOnly: form.rawCaptureOnly })),
      ],
      duplicateCount: forms.duplicates,
      storageLinked: hasStorage,
    });
  }

  const operationalNames = new Set(Object.keys(OPERATIONAL_TABLES));
  const knownDatasetTables = new Set(Object.values(DATASETS).map(dataset => dataset.table));
  const physicalTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const operational = physicalTables.filter(name => operationalNames.has(name)).map(table => ({
    table,
    labelAr: OPERATIONAL_TABLES[table],
    ...tableStats(db, table),
    contentPolicy: OPERATIONAL_COLUMNS[table]?.length ? 'allowlisted_columns' : 'count_only',
    browseable: Boolean(OPERATIONAL_COLUMNS[table]?.length),
  }));
  const unclassifiedDatasets = typedDatasets.filter(item => !mappedKeys.has(item.key)).map(item => ({
    ...item,
    table: DATASETS[item.key].table,
    latestUpdatedAt: item.available ? tableStats(db, DATASETS[item.key].table).latestUpdatedAt : null,
    state: item.available && item.count ? 'filled' : item.available ? 'empty' : 'unavailable',
    sourceType: sourceTypePresence(db, DATASETS[item.key].table),
    browseable: Boolean(item.available),
    countOnlyReason: item.available ? null : 'الجدول المسجل غير متاح في إصدار قاعدة البيانات الحالي.',
  }));
  const knownTables = new Set([...knownDatasetTables, ...operationalNames]);
  const unclassifiedTables = physicalTables.filter(name => !knownTables.has(name)).map(table => {
    const link = LEGACY_TABLE_LINKS[table];
    const count = tablePresent(db, table)
      ? link && tablePresent(db, 'form_record_legacy_links')
        ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)} legacy
            WHERE NOT EXISTS (SELECT 1 FROM form_record_legacy_links link WHERE link.legacy_entity_type=? AND link.legacy_entity_id=legacy.${quote(link.pk)})`)
          .get(link.type).count ?? 0)
        : rowCount(db, table)
      : 0;
    return {
      table,
      labelAr: link ? 'سجلات قديمة غير مرتبطة بسجل مركزي' : COUNT_ONLY_TABLES[table]?.labelAr ?? UNCLASSIFIED_TABLE_LABELS[table] ?? 'جدول غير مسجل في فهرس العرض',
      count,
      latestUpdatedAt: tableStats(db, table).latestUpdatedAt,
      state: count ? 'filled' : 'empty',
      contentPolicy: LEGACY_TABLE_FIELDS[table] ? 'allowlisted_columns' : 'count_only',
      countOnlyReason: link ? 'يعرض السجلات التي لم يُعثر لها على رابط مركزي فقط.'
        : COUNT_ONLY_TABLES[table]?.reason ?? 'لا توجد له مواصفة عرض آمنة مسجلة؛ يعرض العدد والحالة فقط.',
      browseable: Boolean(LEGACY_TABLE_FIELDS[table]),
      classification: link ? 'legacy_compatibility' : Object.hasOwn(COUNT_ONLY_TABLES, table) ? 'count_only_sensitive'
        : Object.hasOwn(UNCLASSIFIED_TABLE_LABELS, table) ? 'legacy_unmapped' : 'unregistered',
    };
  });

  return {
    catalogVersion: catalog.version,
    sourceNote: catalog.sourceNote,
    domains: catalog.domains.map(domain => ({
      code: domain.code,
      name: domain.name,
      order: domain.order,
      definitionState: domain.definitionState,
      groups: domain.groups.map(group => groupSummaries.get(group.code)),
    })),
    operational,
    unclassified: { datasets: unclassifiedDatasets, tables: unclassifiedTables },
    totals: {
      domains: catalog.domains.length,
      groups: [...groupsByCode.values()].length,
      linkedGroups: [...groupSummaries.values()].filter(group => group.storageLinked).length,
      mappedRecords: [...groupSummaries.values()].reduce((sum, group) => sum + group.count, 0),
      operationalTables: operational.length,
      unclassifiedDatasets: unclassifiedDatasets.length,
      unclassifiedTables: unclassifiedTables.length,
    },
  };
}

function formCountsForCode(db, formCode) {
  if (!tablePresent(db, 'form_records')) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM form_records record
    JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
    WHERE form.form_code=? AND version.status='published' AND record.record_status='approved'`).get(formCode).count ?? 0);
}

function sourceTypePresence(db, table) {
  const columns = new Set(tableColumns(db, table).map(column => column.name));
  if (!columns.has('source_id') || !tablePresent(db, 'data_sources')) return 'unknown';
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)} WHERE source_id IS NOT NULL`).get();
  return Number(row.count) ? 'recorded' : 'unknown';
}

function sourceTypeLabels(db, rows) {
  const sourceIds = [...new Set(rows.map(row => row.source_id).filter(value => value !== null && value !== undefined).map(Number))];
  if (!sourceIds.length || !tablePresent(db, 'data_sources')) return Object.fromEntries(rows.map(row => [row.source_id, row.source_id ? 'مصدر مسجل غير مصنف' : 'المصدر غير موثق']));
  const placeholders = sourceIds.map(() => '?').join(',');
  return Object.fromEntries(db.prepare(`SELECT source_id,source_type FROM data_sources WHERE source_id IN (${placeholders})`).all(...sourceIds)
    .map(row => [String(row.source_id), SOURCE_LABELS[row.source_type] ?? 'مصدر مسجل غير مصنف']));
}

function listGroup(db, request = {}) {
  const code = String(request.groupCode ?? '').trim();
  const sourceKey = String(request.sourceKey ?? '').trim();
  const overview = getOverview(db);
  const group = overview.domains.flatMap(domain => domain.groups).find(item => item.code === code);
  if (!group) throw new Error('المجموعة المطلوبة غير موجودة في كتالوج الإدخال.');
  const source = group.sources.find(item => item.key === sourceKey);
  if (!source) throw new Error('مصدر البيانات غير مربوط بهذه المجموعة.');
  const geoUnitId = Number(request.geoUnitId);
  if (!Number.isSafeInteger(geoUnitId) || geoUnitId <= 0) throw new Error('اختر المديرية قبل استعراض بياناتها.');
  const periodId = Number(request.periodId);
  const geo = db.prepare(`SELECT geo_unit_id,name_ar FROM geographic_units WHERE geo_unit_id=? AND is_active=1
    AND geo_unit_type_id=(SELECT geo_unit_type_id FROM geo_unit_types WHERE type_code='directorate')`).get(geoUnitId);
  if (!geo) throw new Error('المديرية المطلوبة غير موجودة أو غير نشطة.');
  const limitNumber = Number(request.limit);
  const limit = Number.isFinite(limitNumber) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitNumber))) : 50;
  const offsetNumber = Number(request.offset);
  const offset = Number.isFinite(offsetNumber) ? Math.min(1000000, Math.max(0, Math.trunc(offsetNumber))) : 0;
  const search = String(request.search ?? '').trim().slice(0, 120);
  if (source.type === 'dataset') {
    const description = domainService.describe(db, source.datasetKey);
    const approvalField = description.fields.find(field => ['approval_status','review_status','record_status'].includes(field.name));
    if (!approvalField) return { rows: [], total: 0, limit, offset, fields: description.fields,
      source: { ...source, sourceType: 'recorded_when_present', unlinkedForDirectorate: true }, requiresApproval: true };
    const hasGeo = description.fields.some(field => field.name === 'geo_unit_id');
    if (!hasGeo) return { rows: [], total: 0, limit, offset, fields: description.fields, source: { ...source, sourceType: 'recorded_when_present', unlinkedForDirectorate: true }, requiresGeography: true };
    const filters = [{ field: 'geo_unit_id', value: geoUnitId }, { field: approvalField.name, value: 'approved' }];
    if (Number.isSafeInteger(periodId) && periodId > 0 && description.fields.some(field => field.name === 'period_id')) filters.push({ field: 'period_id', value: periodId });
    const result = domainService.list(db, { dataset: source.datasetKey, limit, offset, search, filters });
    const sourceTypes = sourceTypeLabels(db, result.rows);
    return {
      ...result,
      source: { ...source, sourceType: 'recorded_when_present' },
      rows: result.rows.map(row => ({ ...row, _sourceType: sourceTypes[String(row.source_id)] ?? (row.source_id ? 'مصدر مسجل غير مصنف' : 'المصدر غير موثق') })),
    };
  }
  const definition = recordService.getFormDefinition(db, source.formVersionId);
  const result = recordService.listRecords(db, { formVersionId: source.formVersionId, geoUnitId, periodId, status: 'approved', limit, offset, search });
  const fields = [
    { name: 'record_label', labelAr: 'اسم السجل' },
    { name: 'geo_name', labelAr: 'الوحدة الجغرافية' },
    { name: 'period_label', labelAr: 'الفترة' },
    ...definition.fields.map(field => ({
      name: `value:${field.field_code}`,
      labelAr: field.canonical_name_ar || field.label_ar || field.field_code,
    })),
  ];
  return {
    ...result,
    fields,
    source: { ...source, sourceType: 'record_provenance' },
    rows: result.rows.map(row => {
      const record = recordService.getRecord(db, row.form_record_id);
      const values = Object.fromEntries(definition.fields.map(field => {
        const value = record.values[field.field_code];
        return [`value:${field.field_code}`, value?.state === 'known' ? value.value : value?.state ? `حالة القيمة: ${value.state}` : ''];
      }));
      const sourceTypes = [...new Set(definition.fields.map(field => record.values[field.field_code]?.sourceType).filter(Boolean))];
      const sourceLabels = sourceTypes.map(type => SOURCE_LABELS[type] ?? 'مصدر مسجل غير مصنف');
      const sourceLabel = sourceLabels.length === 1 ? sourceLabels[0]
        : sourceLabels.length > 1 ? `مصادر موثقة متعددة: ${[...new Set(sourceLabels)].join('، ')}` : 'المصدر غير موثق';
      return { ...row, ...values, _sourceType: sourceLabel };
    }),
  };
}

function listOperationalTable(db, request = {}) {
  const table = String(request.table ?? '').trim();
  if (!Object.hasOwn(OPERATIONAL_COLUMNS, table) || !OPERATIONAL_COLUMNS[table]?.length || !tablePresent(db, table)) throw new Error('الجدول التشغيلي غير متاح للعرض المباشر.');
  const columns = new Map(tableColumns(db, table).map(column => [column.name, column]));
  const fields = OPERATIONAL_COLUMNS[table].filter(([name]) => columns.has(name)).map(([name, labelAr]) => ({
    name,
    labelAr,
    type: /sha256|original_file|content|payload_json|old_value_json|new_value_json|metadata_json/.test(name) ? 'metadata' : 'value',
  }));
  const limitNumber = Number(request.limit);
  const limit = Number.isFinite(limitNumber) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitNumber))) : 50;
  const offsetNumber = Number(request.offset);
  const offset = Number.isFinite(offsetNumber) ? Math.min(1000000, Math.max(0, Math.trunc(offsetNumber))) : 0;
  const term = String(request.search ?? '').trim().slice(0, 120);
  const searchable = fields.filter(field => ['TEXT', ''].includes(String(columns.get(field.name)?.type ?? '').toUpperCase())
    && !/(notes|details|reason|description|payload|json|formula|raw_value|original_value)/i.test(field.name));
  const conditions = [];
  const params = [];
  if (term && searchable.length) {
    conditions.push(`(${searchable.map(field => `CAST(${quote(field.name)} AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (const _field of searchable) params.push(`%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const primary = [...columns.values()].find(column => column.pk)?.name ?? null;
  const order = primary ? `ORDER BY ${quote(primary)} DESC` : '';
  const fieldSql = fields.map(field => quote(field.name)).join(',');
  const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)} ${where}`).get(...params).count ?? 0);
  const rows = fieldSql ? db.prepare(`SELECT ${fieldSql} FROM ${quote(table)} ${where} ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) : [];
  const latestUpdatedAt = tableStats(db, table).latestUpdatedAt;
  return { table, labelAr: OPERATIONAL_TABLES[table], fields, rows, total: count, limit, offset, latestUpdatedAt };
}

function listUnclassifiedTable(db, request = {}) {
  const table = String(request.table ?? '').trim();
  const link = LEGACY_TABLE_LINKS[table] ?? null;
  if (!Object.hasOwn(LEGACY_TABLE_FIELDS, table) || !tablePresent(db, table)) throw new Error('الجدول القديم غير متاح للعرض المحدود.');
  const columns = new Map(tableColumns(db, table).map(column => [column.name, column]));
  const fields = LEGACY_TABLE_FIELDS[table].filter(([name]) => columns.has(name)).map(([name, labelAr]) => ({ name, labelAr }));
  const primaryKey = link?.pk ?? fields[0]?.name;
  if (!primaryKey || !columns.has(primaryKey)) throw new Error('لا يوجد معرّف آمن لسجلات هذا الجدول.');
  const limitNumber = Number(request.limit);
  const limit = Number.isFinite(limitNumber) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitNumber))) : 50;
  const offsetNumber = Number(request.offset);
  const offset = Number.isFinite(offsetNumber) ? Math.min(1000000, Math.max(0, Math.trunc(offsetNumber))) : 0;
  const term = String(request.search ?? '').trim().slice(0, 120);
  const searchable = fields.filter(field => /TEXT|CHAR|CLOB/i.test(String(columns.get(field.name)?.type ?? '')) && !['notes', 'description'].includes(field.name));
  const conditions = [];
  const params = [];
  if (link && tablePresent(db, 'form_record_legacy_links')) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM form_record_legacy_links link WHERE link.legacy_entity_type=? AND link.legacy_entity_id=legacy.${quote(link.pk)})`);
    params.push(link.type);
  }
  if (term && searchable.length) {
    conditions.push(`(${searchable.map(field => `CAST(legacy.${quote(field.name)} AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (const _field of searchable) params.push(`%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const fieldSql = fields.map(field => `legacy.${quote(field.name)}`).join(',');
  const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)} legacy ${where}`).get(...params).count ?? 0);
  const rows = db.prepare(`SELECT ${fieldSql} FROM ${quote(table)} legacy ${where} ORDER BY legacy.${quote(primaryKey)} DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  const sourceIds = [...new Set(rows.map(row => row.source_id).filter(value => value != null).map(Number))];
  const sourceTypes = sourceIds.length && tablePresent(db, 'data_sources')
    ? Object.fromEntries(db.prepare(`SELECT source_id,source_type FROM data_sources WHERE source_id IN (${sourceIds.map(() => '?').join(',')})`).all(...sourceIds)
      .map(row => [String(row.source_id), row.source_type])) : {};
  return { table, labelAr: 'سجلات قديمة غير مرتبطة بسجل مركزي', fields,
    rows: rows.map(row => ({ ...row, _sourceType: SOURCE_LABELS[sourceTypes[String(row.source_id)]] ?? (row.source_file ? 'ملف مصدر مسجل' : 'المصدر غير موثق') })),
    total, limit, offset, latestUpdatedAt: tableStats(db, table).latestUpdatedAt };
}

function listUnclassifiedDataset(db, request = {}) {
  const datasetKey = String(request.dataset ?? '').trim();
  const assigned = new Set(Object.values(GROUP_DATASETS).flat());
  if (assigned.has(datasetKey) || !Object.hasOwn(DATASETS, datasetKey)) throw new Error('مجموعة البيانات غير مصنفة أو غير مسموح بها.');
  const result = listGroupDataset(db, datasetKey, request);
  const sourceTypes = sourceTypeLabels(db, result.rows);
  return { ...result, rows: result.rows.map(row => ({ ...row,
    _sourceType: sourceTypes[String(row.source_id)] ?? (row.source_id ? 'مصدر مسجل غير مصنف' : 'المصدر غير موثق') })) };
}

function listGroupDataset(db, datasetKey, request = {}) {
  const limitNumber = Number(request.limit);
  const limit = Number.isFinite(limitNumber) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitNumber))) : 50;
  const offsetNumber = Number(request.offset);
  const offset = Number.isFinite(offsetNumber) ? Math.min(1000000, Math.max(0, Math.trunc(offsetNumber))) : 0;
  return domainService.list(db, { dataset: datasetKey, search: String(request.search ?? '').slice(0, 120), limit, offset });
}

module.exports = { GROUP_DATASETS, FORM_LEGACY_LINKS, OPERATIONAL_TABLES, OPERATIONAL_COLUMNS, COUNT_ONLY_TABLES, getOverview, listGroup, listOperationalTable, listUnclassifiedDataset, listUnclassifiedTable };
