'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const migrationIntegrity = require('./migration-integrity.cjs');

const VERSION = 1;
const CODE = 'unified-development-model-v1';
const SQL_FILE = path.join(__dirname,'unified-development-model-v1.sql');

const CATALOG = [
['geography','البيانات الإدارية والجغرافية',[
['administrative','الوحدات الإدارية',['governorate.name|اسم المحافظة|text','governorate.code|رمز المحافظة|text','directorate.name|اسم المديرية|text','directorate.code|رمز المديرية|text','directorate.center|اسم مركز المديرية|text','isolation.name|اسم العزلة|text','isolation.code|رمز العزلة|text','settlement.name|اسم التجمع السكاني|text','settlement.code|رمز التجمع السكاني|text','village.name|اسم القرية|text','locality.name|اسم المحلة|text','neighborhood.name|اسم الحارة|text','geography.area|المساحة الجغرافية|decimal|km2','geography.distance_governorate|المسافة عن مركز المحافظة|decimal|km','geography.distance_directorate|المسافة عن مركز المديرية|decimal|km']],
['boundaries','الحدود والتمثيل الإداري',['geography.boundary.north|الحد الشمالي|text','geography.boundary.south|الحد الجنوبي|text','geography.boundary.east|الحد الشرقي|text','geography.boundary.west|الحد الغربي|text','geography.road_access|طبيعة الطرق المؤدية إلى الموقع|long_text','geography.electoral_districts|عدد الدوائر الانتخابية|integer','geography.electoral_centers|عدد المراكز الانتخابية|integer','governance.council.members|عدد أعضاء السلطة المحلية|integer']]
]],
['population','السكان والأسر والتركيبة الديموغرافية',[
['population','السكان والتوزيع الديموغرافي',['population.total|إجمالي عدد السكان|integer|person|sex,age_group','population.male|عدد السكان الذكور|integer|person|age_group','population.female|عدد السكان الإناث|integer|person|age_group','population.rural|سكان المناطق الريفية|integer|person','population.density|الكثافة السكانية|decimal|density','population.age_sex|عدد السكان حسب الفئة العمرية والجنس|integer|person|sex,age_group']],
['households','الأسر والمساكن',['households.total|إجمالي عدد الأسر|integer|household','housing.total|إجمالي عدد المساكن|integer|household','households.share|نسبة الأسر|decimal|percent','housing.share|نسبة المساكن|decimal|percent']]
]],
['poverty','الفقر ومستويات المعيشة والاقتصاد الأسري',[
['poverty','الفقر وخطوط الفقر',['poverty.households.upper|عدد الأسر تحت خط الفقر الأعلى|integer|household','poverty.rate.upper|نسبة الأسر تحت خط الفقر الأعلى|decimal|percent','poverty.households.lower|عدد الأسر تحت خط الفقر الأدنى|integer|household','poverty.rate.lower|نسبة الأسر تحت خط الفقر الأدنى|decimal|percent','poverty.methodology|معايير احتساب الفقر|long_text']],
['livelihoods','الشرائح الاجتماعية والدخل',['livelihood.social_group|نوع الشريحة الاجتماعية|reference||social_group','livelihood.occupation|نوع المهنة|reference||occupation','livelihood.group_size|عدد أفراد الشريحة الاجتماعية|integer|person','household.income|مستوى دخل الأسرة|decimal|currency','household.expenditure|مستوى إنفاق الأسرة|decimal|currency','household.inputs|قيمة المدخلات الأسرية|decimal|currency','household.outputs|قيمة المخرجات الأسرية|decimal|currency']],
['assets','الملكية والأصول',['household.housing_ownership|ملكية السكن|reference||ownership','household.vehicle|امتلاك وسيلة نقل|boolean','household.land|امتلاك الأراضي|boolean','household.livestock|امتلاك الثروة الحيوانية|boolean','household.beehives|امتلاك خلايا النحل|boolean']]
]],
['protection','الفئات المستهدفة والحماية الاجتماعية',[
['disability','الأشخاص ذوو الإعاقة',['protection.disability.total|إجمالي الأشخاص ذوي الإعاقة|integer|person|sex,age_group','protection.disability.type|نوع الإعاقة|reference||disability_type','protection.disability.cause|أسباب الإعاقة|long_text','protection.disability.status|حالة الإعاقة|reference||case_status','protection.disability.participation|المشاركة المجتمعية|long_text','protection.disability.needs|الخدمات والاحتياجات|long_text']],
['displacement','النزوح والفئات المجتمعية',['protection.displacement.date|تاريخ النزوح|date','protection.displacement.cause|أسباب النزوح|long_text','protection.displacement.location|مكان التواجد|text','protection.displacement.status|حالة الاستقرار|reference||case_status','protection.displacement.return|إمكانية العودة|boolean','protection.displacement.housing|نمط السكن|reference||housing_type']],
['assistance','المساعدات والحماية الاجتماعية',['protection.assistance.eligible|عدد الأسر المستحقة للمساعدة|integer|household','protection.assistance.beneficiaries|عدد الأسر المستفيدة|integer|household','protection.assistance.unserved|عدد الأسر الفقيرة غير المستفيدة|integer|household','protection.assistance.amount|المبلغ المنصرف|decimal|currency','protection.assistance.cycle|دورة الصرف|reference||payment_cycle']]
]],
['environment','الموارد الطبيعية والبيئة والمناخ',[
['terrain','التضاريس والخصائص الطبيعية',['environment.mountain.count|عدد الجبال|integer','environment.mountain.names|أسماء الجبال|long_text','environment.valley.count|عدد الوديان|integer','environment.valley.names|أسماء الوديان|long_text','environment.slope.names|أسماء المنحدرات|long_text','environment.terrain.use|مجالات استخدام التضاريس|long_text']],
['climate','المناخ والطقس',['climate.winter.humidity|نسبة الرطوبة في الشتاء|decimal|percent','climate.summer.humidity|نسبة الرطوبة في الصيف|decimal|percent','climate.winter.temperature|درجة الحرارة في الشتاء|decimal|celsius','climate.summer.temperature|درجة الحرارة في الصيف|decimal|celsius','climate.rainfall|متوسط هطول الأمطار|decimal|millimeter','climate.rainy_season|موسم هطول الأمطار|text','climate.wind_season|موسم هبوب الرياح|text','climate.wind_direction|اتجاه هبوب الرياح|reference||wind_direction']],
['soil_land','التربة والأراضي',['environment.soil.type|نوع التربة|reference||soil_type','environment.soil.area|مساحة نوع التربة|decimal|km2','environment.land.arable|المساحة الصالحة للزراعة|decimal|hectare','environment.land.vegetated|المساحة المغطاة بالغطاء النباتي|decimal|km2','environment.land.ownership|طبيعة ملكية الأرض|reference||ownership']],
['water','الموارد المائية الطبيعية',['environment.water.source|نوع مصدر المياه|reference||water_source','environment.water.wells|عدد الآبار|integer','environment.water.well_capacity|سعة الآبار|decimal|m3','environment.water.dam_capacity|سعة الحواجز والسدود|decimal|m3','environment.water.use|استخدام مصادر المياه|long_text','environment.water.problems|مشكلات مصادر المياه|long_text']],
['biodiversity','الغطاء النباتي والحياة البرية والبحرية',['environment.plants.trees|أنواع الأشجار|long_text','environment.plants.shrubs|أنواع الشجيرات|long_text','environment.plants.economic|أنواع النباتات الاقتصادية|long_text','environment.wildlife.animals|أنواع الحيوانات البرية|long_text','environment.wildlife.birds|أنواع الطيور|long_text','environment.marine.species|أنواع الأحياء البحرية|long_text','environment.marine.stock|المخزون السمكي|long_text']],
['degradation','التدهور البيئي',['environment.degradation.desertification|درجة التصحر|decimal','environment.degradation.erosion|درجة انجراف التربة|decimal','environment.degradation.water_pollution|درجة تلوث المياه الجوفية|decimal','environment.degradation.groundwater|درجة استنزاف المياه الجوفية|decimal','environment.degradation.vegetation|درجة تدهور الغطاء النباتي|decimal','environment.degradation.marine|درجة تدهور الموارد البحرية|decimal']]
]],
['society_culture','المجتمع والثقافة والموروث',[
['cohesion','التركيبة الاجتماعية والتماسك',['society.structure|نوع التركيبة الاجتماعية|reference||social_group','society.cooperation|درجة التعاون المجتمعي|decimal','society.differences|درجة الاختلاف المجتمعي|decimal','society.influence|درجة النفوذ المجتمعي|decimal','society.development_effects|آثار التركيبة الاجتماعية على التنمية|long_text']],
['customs','العادات والتقاليد',['culture.custom.name|اسم العادة أو التقليد|text','culture.custom.description|وصف العادة أو التقليد|long_text','culture.custom.status|حالة العادة|reference||case_status','culture.custom.decline_causes|أسباب اندثار العادة|long_text','culture.custom.recommendations|التوصيات المتعلقة بالعادات والتقاليد|long_text']],
['heritage','الموروث الثقافي',['culture.heritage.name|اسم الموروث الثقافي|text','culture.heritage.type|نوع الموروث|reference||heritage_type','culture.heritage.description|وصف الموروث|long_text','culture.heritage.season|موسم الممارسة|text','culture.heritage.condition|الوضع الحالي للموروث|reference||case_status']],
['figures','الشخصيات الاجتماعية',['society.figure.name|اسم الشخصية|text','society.figure.role|صفة الشخصية|text','society.figure.description|وصف الشخصية|long_text','society.figure.strengths|مميزات الشخصية|long_text','society.figure.weaknesses|عيوب الشخصية|long_text']]
]],
['governance','الإدارة المحلية والحوكمة والمؤسسات',[
['local_government','التمثيل والهيكل المحلي',['governance.council.qualification|المؤهل العلمي لأعضاء السلطة المحلية|reference||education_level','governance.council.sex|جنس أعضاء السلطة المحلية|reference||sex']],
['executive','الإدارات والأجهزة التنفيذية',['governance.department.name|اسم الإدارة|text','governance.department.section|اسم القسم|text','governance.department.established|تاريخ تأسيس المرفق|date','governance.staff.official|عدد العاملين الرسميين|integer|person','governance.staff.contract|عدد العاملين المتعاقدين|integer|person','governance.staff.required|العدد اللازم من العاملين|integer|person']],
['institutions','المؤسسات والمرافق المجتمعية',['governance.institution.name|اسم المؤسسة|text','governance.institution.type|نوع المؤسسة|reference||institution_type','governance.institution.purpose|الغرض من المؤسسة|long_text','governance.institution.opinion|رأي المجتمع في المؤسسة|long_text']],
['organizations','الجمعيات والمنظمات والتعاونيات',['governance.organization.name|اسم الجمعية أو المنظمة|text','governance.organization.type|نوع الجمعية أو المنظمة|reference||institution_type','governance.organization.members|عدد الأعضاء|integer|person','governance.organization.capital|رأس المال|decimal|currency','governance.organization.shares|عدد الأسهم|integer','governance.organization.activities|أنشطة الجمعية|long_text']],
['partners','الفاعلون والشركاء',['governance.partner.name|اسم الشريك المحلي|text','governance.partner.start|تاريخ بدء عمل الشريك|date','governance.partner.intervention|مجال تدخل الشريك|long_text','governance.partner.coordinator|الجهة المنسقة للشريك|text','governance.actor.active|عدد الفاعلين النشطين|integer','governance.actor.inactive|عدد الفاعلين غير النشطين|integer']]
]],
['education','التعليم ومحو الأمية',[
['kindergarten','رياض الأطفال',['education.kindergarten.count|عدد رياض الأطفال|integer','education.kindergarten.target|عدد الأطفال في سن الالتحاق|integer|person','education.kindergarten.enrolled|عدد الملتحقين برياض الأطفال|integer|person','education.kindergarten.caregivers|عدد المربيات|integer|person']],
['schools','المدارس والمنشآت التعليمية',['education.school.count|عدد المدارس|integer|school','education.school.name|اسم المدرسة|text','education.school.type|نوع المدرسة|reference||facility_type','education.school.gender|جنس المدرسة|reference||sex','education.school.building|نوع المبنى المدرسي|reference||building_type','education.school.condition|حالة المبنى المدرسي|reference||case_status','education.school.classrooms|عدد الصفوف الدراسية|integer','education.school.sections|عدد الشعب الدراسية|integer']],
['enrollment','الطلاب والالتحاق والتسرب',['education.population_school_age|السكان في سن التعليم|integer|person|sex,age_group','education.enrollment.total|عدد الملتحقين بالتعليم|integer|student|sex,age_group','education.enrollment.rate|نسبة الالتحاق بالتعليم|decimal|percent|sex,age_group','education.dropout.count|عدد المتسربين|integer|student|sex,age_group','education.dropout.rate|نسبة التسرب|decimal|percent|sex,age_group']],
['staff','الكادر التعليمي',['education.staff.teachers|عدد المعلمين|integer|person|sex','education.staff.principals|عدد مديري المدارس|integer|person|sex','education.staff.deputies|عدد وكلاء المدارس|integer|person|sex','education.staff.qualification|المؤهل العلمي للكادر التعليمي|reference||education_level','education.staff.specialty|التخصص التعليمي|reference||specialty']],
['literacy','محو الأمية',['education.literacy.illiterate|عدد الأميين|integer|person|sex,age_group','education.literacy.rate|نسبة الأمية|decimal|percent|sex,age_group','education.literacy.centers|عدد مراكز محو الأمية|integer','education.literacy.enrolled|عدد الملتحقين بمحو الأمية|integer|person|sex','education.literacy.rate_enrolled|نسبة الالتحاق بمحو الأمية|decimal|percent|sex']]
]],
['health','الصحة والخدمات الصحية',[
['facilities','المرافق الصحية',['health.facility.name|اسم المرفق الصحي|text','health.facility.type|نوع المرفق الصحي|reference||facility_type','health.facility.equipment|حالة اكتمال التجهيزات|reference||case_status','health.facility.operation|حالة تشغيل المرفق|reference||case_status','health.facility.beds|السعة السريرية|integer']],
['coverage','التغطية والخدمات',['health.covered_population|عدد السكان المغطّين بالخدمات الصحية|integer|person','health.coverage_rate|نسبة التغطية الصحية|decimal|percent','health.visitors|عدد المترددين على المرافق الصحية|integer|person|sex','health.services|نوع الخدمات الصحية المقدمة|long_text']],
['diseases','الأمراض والحالات الصحية',['health.disease.type|نوع المرض|reference||disease_type','health.disease.cases|عدد الحالات المرضية|integer|case|sex,age_group','health.disease.deaths|عدد الوفيات بسبب المرض|integer|case|sex,age_group']],
['maternal_child','صحة الأم والطفل والتحصين',['health.infant_deaths|عدد وفيات الأطفال الرضع|integer|person','health.under5_deaths|عدد وفيات الأطفال دون الخامسة|integer|person','health.maternal_deaths|عدد وفيات الأمهات|integer|person','health.immunization.target|عدد الأطفال المستهدفين للتحصين|integer|person','health.immunization.covered|عدد الأطفال الملقحين|integer|person','health.reproductive.beneficiaries|عدد المستفيدات من خدمات الصحة الإنجابية|integer|person']],
['workforce','الكوادر الصحية',['health.staff.physicians|عدد الأطباء|integer|person|sex','health.staff.nurses|عدد الممرضين والممرضات|integer|person|sex','health.staff.technicians|عدد الفنيين والفنيات|integer|person|sex','health.staff.midwives|عدد قابلات المجتمع|integer|person|sex']]
]],
['youth_sports','الثقافة والشباب والرياضة',[
['culture','المرافق الثقافية',['youth.library.count|عدد المكتبات|integer','youth.museum.count|عدد المتاحف|integer','youth.cultural_centers|عدد المراكز الثقافية|integer']],
['sports','الشباب والرياضة',['youth.centers|عدد المراكز الشبابية|integer','sports.facilities|عدد المنشآت الرياضية|integer','sports.teams|عدد الفرق الرياضية|integer','sports.type|نوع النشاط الرياضي|reference||sport_type']]
]],
['infrastructure','البنية التحتية والخدمات الأساسية',[
['water','المياه وإمدادات مياه الشرب',['water.project.name|اسم مشروع المياه|text','water.project.ownership|ملكية مشروع المياه|reference||ownership','water.project.status|حالة مشروع المياه|reference||project_status','water.households_covered|عدد المساكن المزودة بالمياه|integer|household','water.coverage_rate|نسبة التغطية بالمياه|decimal|percent','water.beneficiaries|عدد المستفيدين من المياه|integer|person']],
['sanitation','الصرف الصحي وصحة البيئة',['sanitation.connected_households|عدد المساكن المرتبطة بالصرف الصحي|integer|household','sanitation.coverage_rate|نسبة الاستفادة من الصرف الصحي|decimal|percent','environment.slaughterhouses|عدد المسالخ|integer','environment.waste_sites|عدد مقالب المخلفات|integer','environment.waste_workers|عدد العاملين في صحة البيئة|integer|person']],
['energy','الكهرباء والطاقة',['energy.source|مصدر الكهرباء أو الطاقة|reference||energy_source','energy.covered_households|عدد المساكن المزودة بالكهرباء|integer|household','energy.coverage_rate|نسبة التغطية الكهربائية|decimal|percent']],
['roads','الطرق والنقل',['roads.name|اسم الطريق|text','roads.surface|نوع سطح الطريق|reference||road_surface','roads.class|تصنيف الطريق|reference||road_class','roads.length|طول الطريق|decimal|km','roads.condition|الحالة الراهنة للطريق|reference||case_status','roads.beneficiaries|عدد السكان المستفيدين من الطريق|integer|person','roads.paved_share|نسبة الطرق المزفلتة|decimal|percent','roads.unpaved_share|نسبة الطرق الترابية|decimal|percent']],
['telecom','الاتصالات',['telecom.exchange_capacity|سعة السنترال|integer','telecom.subscribers|عدد المشتركين|integer','telecom.capacity_rate|نسبة استغلال السعة|decimal|percent','telecom.coverage_rate|نسبة التغطية بالاتصالات|decimal|percent']]
]],
['agriculture','الزراعة والري والثروة الحيوانية والسمكية',[
['irrigation','منشآت حصاد المياه والري',['agriculture.water_asset.name|اسم منشأة حصاد المياه|text','agriculture.water_asset.capacity|السعة التخزينية|decimal|m3','agriculture.water_asset.status|حالة منشأة حصاد المياه|reference||case_status','agriculture.irrigation.type|نوع نظام الري|reference||irrigation_type','agriculture.irrigated_area|المساحة الزراعية المروية|decimal|hectare']],
['land','الأراضي الزراعية والحيازات',['agriculture.land.total|إجمالي المساحة الزراعية|decimal|hectare','agriculture.land.cultivated|المساحة المزروعة|decimal|hectare','agriculture.land.holders|عدد الحائزين الزراعيين|integer|person|sex','agriculture.land.workers|عدد العاملين في القطاع الزراعي|integer|person|sex']],
['crops','المحاصيل والإنتاج الزراعي',['agriculture.crop.type|نوع المحصول|reference||crop_type','agriculture.crop.category|فئة المحصول|reference||crop_category','agriculture.crop.area|المساحة المزروعة بالمحصول|decimal|hectare','agriculture.crop.production|كمية الإنتاج الزراعي|decimal|tonne','agriculture.crop.yield|إنتاجية الهكتار|decimal|tonne_per_hectare']],
['livestock','الثروة الحيوانية والدواجن والنحل',['agriculture.livestock.species|نوع الحيوان|reference||livestock_species','agriculture.livestock.headcount|عدد رؤوس الحيوانات|integer|head','agriculture.livestock.breeders|عدد مربي الثروة الحيوانية|integer|person|sex','agriculture.livestock.disease|المرض الحيواني|reference||animal_disease','agriculture.livestock.infection|معدل الإصابة|decimal|percent','agriculture.poultry.farms|عدد مزارع الدواجن|integer','agriculture.honey.hives|عدد خلايا النحل|integer','agriculture.honey.production|إجمالي إنتاج العسل|decimal|kg','agriculture.honey.price|متوسط سعر كيلو العسل|decimal|currency']],
['fisheries','الثروة السمكية والصيد',['fisheries.zone|منطقة الصيد|reference||fishery_zone','fisheries.vessel.type|نوع قارب الصيد|reference||fishery_vessel','fisheries.vessels|عدد قوارب الصيد|integer','fisheries.fishers|عدد المشتغلين في الصيد|integer|person','fisheries.production|كمية الإنتاج السمكي|decimal|tonne','fisheries.exports|حجم الصادرات السمكية|decimal|tonne']],
['markets','الخدمات الزراعية والتسويق',['agriculture.service.centers|عدد مراكز الخدمات الزراعية|integer','agriculture.service.beneficiaries|عدد المستفيدين من الخدمات الزراعية|integer|person','agriculture.marketing.product|نوع المنتج المسوّق|reference||crop_type','agriculture.marketing.quantity|كمية المنتج المسوّق|decimal','agriculture.marketing.cold_storage|توفر التخزين المبرد|boolean']]
]],
['economy','الصناعة والقطاع الخاص والأنشطة الاقتصادية والسياحة',[
['industry','المنشآت الصناعية والإنتاج',['economy.industry.type|نوع المنشأة الصناعية|reference||establishment_type','economy.industry.count|عدد المنشآت الصناعية|integer','economy.industry.quantity|حجم الإنتاج الصناعي|decimal','economy.industry.value|قيمة الإنتاج الصناعي|decimal|currency','economy.industry.workers|عدد العاملين في المنشآت الصناعية|integer|person|sex']],
['establishments','المنشآت المهنية والتجارية والخدمية',['economy.establishment.type|نوع المنشأة الاقتصادية|reference||establishment_type','economy.establishment.activity|النشاط الاقتصادي|reference||economic_activity','economy.establishment.count|عدد المنشآت حسب النشاط|integer','economy.establishment.workers|عدد العاملين حسب النشاط|integer|person|sex']],
['tourism','السياحة والمواقع السياحية',['tourism.site.name|اسم الموقع السياحي|text','tourism.site.description|وصف الموقع السياحي|long_text','tourism.site.access|إمكانية الوصول إلى الموقع|reference||accessibility','tourism.visitors.domestic|عدد الزوار المواطنين|integer|person','tourism.visitors.foreign|عدد الزوار الأجانب|integer|person','tourism.facilities|عدد المنشآت السياحية|integer']]
]],
['finance','المشاريع والتمويل والموازنات والإيرادات',[
['projects','المشاريع والمبادرات',['projects.name|اسم المشروع|text','projects.type|نوع المشروع|reference||project_type','projects.cost|تكلفة المشروع|decimal|currency','projects.community_contribution|مساهمة المجتمع|decimal|currency','projects.authority_contribution|مساهمة السلطة المحلية|decimal|currency','projects.completion|نسبة الإنجاز الفني|decimal|percent','projects.status|حالة المشروع|reference||project_status']],
['budgets','الموازنات والنفقات',['finance.budget.approved|المبلغ المعتمد|decimal|currency','finance.budget.revised|المبلغ المعدل|decimal|currency','finance.budget.actual|الإنفاق الفعلي|decimal|currency','finance.expenditure.type|نوع النفقة|reference||expenditure_type']],
['revenues','الموارد والإيرادات',['finance.revenue.type|نوع المورد أو الإيراد|reference||revenue_type','finance.revenue.assessed|قيمة الربط السنوي|decimal|currency','finance.revenue.collected|قيمة الإيراد المحصل|decimal|currency','finance.revenue.remitted|المبلغ المورّد|decimal|currency','finance.revenue.rate|نسبة التحصيل|decimal|percent','finance.revenue.gap|الفارق بين الربط والتحصيل|decimal|currency']]
]],
['indicators','المؤشرات التنموية والقياس والمقارنات',[
['definitions','تعريف المؤشرات',['indicator.name|اسم المؤشر|text','indicator.definition|تعريف المؤشر|long_text','indicator.formula|معادلة المؤشر|long_text','indicator.numerator|بسط المؤشر|text','indicator.denominator|مقام المؤشر|text','indicator.methodology|منهجية احتساب المؤشر|long_text','indicator.direction|اتجاه المؤشر|reference||indicator_direction','indicator.unit|وحدة قياس المؤشر|reference']],
['targets','نتائج المؤشرات والمستهدفات',['indicator.value|قيمة المؤشر المحسوبة|decimal','indicator.baseline|خط الأساس للمؤشر|decimal','indicator.target|القيمة المستهدفة|decimal','indicator.target_year|سنة استهداف المؤشر|integer','indicator.benchmark|القيمة المرجعية للمؤشر|decimal','indicator.rank|ترتيب الوحدة الجغرافية|integer']]
]],
['analysis','التحليل التنموي والقضايا والأولويات',[
['swot','تحليل SWOT',['analysis.swot.type|نوع عنصر SWOT|reference||swot_type','analysis.swot.description|وصف عنصر SWOT|long_text','analysis.swot.impact|الأثر التنموي|long_text','analysis.swot.response|الاستجابة أو التوصية|long_text']],
['pestle','تحليل PESTLE',['analysis.pestle.dimension|البعد التحليلي|reference||pestle_dimension','analysis.pestle.description|وصف العامل|long_text','analysis.pestle.impact|أثر العامل|long_text','analysis.pestle.horizon|المدى الزمني|reference']],
['issues','القضايا والتحديات التنموية',['analysis.issue.title|عنوان القضية التنموية|text','analysis.issue.description|وصف القضية|long_text','analysis.issue.direct_causes|الأسباب المباشرة|long_text','analysis.issue.root_causes|الأسباب الجذرية|long_text','analysis.issue.effects|آثار القضية|long_text','analysis.issue.affected_share|نسبة السكان المتأثرين|decimal|percent','analysis.issue.evidence|الأدلة ومصادر التحقق|long_text']],
['priorities','تحديد الأولويات',['analysis.priority.criterion|معيار الأولوية|reference||priority_criterion','analysis.priority.raw_score|الدرجة الخام|decimal','analysis.priority.weight|وزن المعيار|decimal','analysis.priority.weighted_score|الدرجة المرجحة|decimal','analysis.priority.rank|ترتيب الأولوية|integer','analysis.priority.level|مستوى الأولوية|reference||priority_level']],
['comparisons','المقارنات',['analysis.comparison.domain|محور المقارنة|reference||comparison_domain','analysis.comparison.score|درجة المقارنة|decimal','analysis.comparison.total|مجموع درجات المقارنة|decimal','analysis.comparison.rank|ترتيب التجمع|integer']]
]],
['planning','التخطيط الاستراتيجي والبرامج والمشاريع',[
['objectives','الأهداف والنتائج',['planning.objective.general|الهدف التنموي العام|long_text','planning.objective.strategic|الهدف الاستراتيجي|long_text','planning.objective.specific|الهدف الفرعي|long_text','planning.result.target|النتيجة المستهدفة|long_text','planning.baseline|خط الأساس|decimal','planning.target_value|القيمة المستهدفة|decimal']],
['programs','البرامج والمبادرات',['planning.program.name|اسم البرنامج|text','planning.program.description|وصف البرنامج|long_text','planning.initiative.name|اسم المبادرة|text','planning.activity.name|اسم النشاط الرئيسي|text','planning.output|المخرج المتوقع|long_text']],
['monitoring','متابعة التنفيذ',['planning.performance.indicator|مؤشر الأداء|text','planning.performance.current|قيمة الأداء الحالية|decimal','planning.performance.target|مستهدف الأداء|decimal','planning.performance.completion|نسبة الإنجاز|decimal|percent','planning.risk|المخاطر|long_text','planning.assumption|الافتراضات|long_text','planning.verification|مصدر التحقق|text']]
]],
['metadata','البيانات المشتركة والتوثيق والجودة',[
['identifiers','المعرفات والروابط',['metadata.record_code|رمز السجل|text','metadata.entity_code|رمز الكيان|text','metadata.geo_reference|مرجع الوحدة الجغرافية|entity_reference','metadata.sector_reference|مرجع القطاع|reference','metadata.period_reference|مرجع الفترة الزمنية|reference']],
['source','المصدر والتتبع',['metadata.source_document|اسم وثيقة المصدر|text','metadata.source_organization|الجهة المصدرة للبيانات|text','metadata.collection_date|تاريخ جمع البيانات|date','metadata.receipt_date|تاريخ استلام البيانات|date','metadata.source_locator|موضع القيمة في المصدر|text','metadata.original_value|القيمة الأصلية قبل المعالجة|long_text','metadata.transformation|طريقة التحويل والمعالجة|long_text']],
['quality','الجودة والمراجعة والتدقيق',['metadata.quality_status|حالة جودة البيانات|reference||quality_status','metadata.completeness|حالة اكتمال البيانات|reference||quality_status','metadata.verification|حالة التحقق|reference||quality_status','metadata.review|حالة المراجعة|reference||quality_status','metadata.quality_note|ملاحظات جودة البيانات|long_text','metadata.created_by|معرف مدخل السجل|text','metadata.created_at|تاريخ إنشاء السجل|datetime','metadata.updated_by|معرف آخر من حدّث السجل|text','metadata.updated_at|تاريخ آخر تحديث|datetime','metadata.approved_by|معرف المعتمد|text','metadata.approved_at|تاريخ الاعتماد|datetime']]
]]
];

const LEGACY = {
'governorate.name':'directorate.governorate','directorate.name':'directorate.districtName',
'population.total':'directorate.population',
'population.density':'directorate.densityPerKm2',
'population.rural':'directorate.ruralPopulation',
'water.coverage_rate':'directorate.waterCoverage',
'roads.paved_share':'directorate.pavedRoads',
'finance.revenue.collected':'directorate.revenue',
'education.school.count':'directorate.schools',
'education.enrollment.total':'directorate.enrolledStudents',
'agriculture.crop.production':'directorate.agriProduction',
'agriculture.livestock.headcount':'directorate.livestockHeads',
'economy.value_chains.active':'directorate.valueChains',
'economy.value_chains.inactive':'directorate.inactiveValueChains',
'economy.unemployment.rate':'directorate.unemployment',
'governance.organization.associations':'directorate.associations',
'protection.assistance.goods_tons':'directorate.goodsTons',
'protection.front_line':'directorate.frontLine',
'poverty.rate':'directorate.povertyRatio',
'protection.vulnerable_share':'directorate.vulnerableGroups',
'metadata.reviewer_decision':'directorate.reviewerDecision'
};

const UNITS = [
['percent','نسبة','ratio'],['km2','كيلومتر مربع','area'],['hectare','هكتار','area'],
['celsius','درجة مئوية','temperature'],['millimeter','ملليمتر','length'],['m3','متر مكعب','volume'],
['kg','كيلوجرام','mass'],['household','أسرة','count'],['case','حالة','count'],
['currency','عملة','currency'],['tonne_per_hectare','طن/هكتار','yield']
];

const DIMS = [
['sex','الجنس',['male:ذكر','female:أنثى','unknown:غير محدد']],
['age_group','الفئة العمرية',['0_5:0–5 سنوات','6_14:6–14 سنة','15_17:15–17 سنة','18_60:18–60 سنة','61_plus:61 سنة فأكثر']],
['education_level','المستوى التعليمي',['none:بدون تعليم','basic:أساسي','secondary:ثانوي','diploma:دبلوم','bachelor:بكالوريوس','postgraduate:دراسات عليا']],
['urban_rural','التصنيف الحضري والريفي',['urban:حضري','rural:ريفي']],
['priority_level','مستوى الأولوية',['critical:عالية جداً','high:عالية','medium:متوسطة','low:منخفضة']]
];

const REFS = [
['soil_type','أنواع التربة',['sandy:رملية','gravelly:حصوية','calcareous:كلسية','clay:طينية','dunes:كثبان رملية']],
['water_source','مصادر المياه',['rain:أمطار','well:آبار','spring:عيون','ghail:غيول','dam:سدود وحواجز','surface:سطحية','groundwater:جوفية']],
['energy_source','مصادر الطاقة',['central:مركزية','cooperative:تعاونية','private:أهلية','solar:شمسية','other:أخرى']],
['road_surface','سطح الطريق',['asphalt:إسفلتي','gravel:حصوي','dirt:ترابي']],
['road_class','تصنيف الطريق',['international:دولي','national:وطني','local:محلي']],
['facility_type','أنواع المرافق',['school:مدرسة','kindergarten:روضة','hospital:مستشفى','health_center:مركز صحي','health_unit:وحدة صحية','library:مكتبة','youth_center:مركز شبابي','sports:منشأة رياضية']],
['disease_type','أنواع الأمراض',['malaria:ملاريا','diarrhea:إسهالات','schistosomiasis:بلهارسيا','parasites:طفيليات معوية','tuberculosis:سل','measles:حصبة','hepatitis:التهاب كبد','skin:أمراض جلدية','other:أخرى']],
['crop_category','فئات المحاصيل',['cereals:حبوب','vegetables:خضروات','fruits:فواكه','legumes:بقوليات','cash:محاصيل نقدية','fodder:أعلاف','coffee:بن','qat:قات','trees:أشجار']],
['livestock_species','أنواع الثروة الحيوانية',['goat:ماعز','sheep:أغنام','cattle:أبقار','camel:جمال','donkey:حمير','poultry:دواجن']],
['fishery_vessel','أنواع قوارب الصيد',['fiberglass:فيبر','wood:خشب']],
['establishment_type','أنواع المنشآت الاقتصادية',['industrial:صناعية','commercial:تجارية','professional:مهنية','service:خدمية']],
['project_status','حالات المشروع',['planned:مخطط','ongoing:قيد التنفيذ','completed:مكتمل','stalled:متعثر','cancelled:ملغي']],
['revenue_type','أنواع الإيرادات',['local:محلية','shared:مشتركة','general_shared:عامة مشتركة','central_support:دعم مركزي']],
['expenditure_type','أنواع النفقات',['operating:تشغيلية','emergency:طارئة','committee:مخصصات لجان','transfer:تحويلات','development:تنموية']],
['institution_type','أنواع المؤسسات',['government:حكومية','civil_society:مجتمع مدني','cooperative:تعاونية','private:خاصة']],
['priority_criterion','معايير الأولوية',['severity:شدة الأثر','scale:اتساع المشكلة','urgency:الإلحاح','affected_population:السكان المتأثرون','feasibility:قابلية المعالجة','equity:الإنصاف']],
['comparison_domain','مجالات المقارنة',['infrastructure:بنية تحتية','human_development:تنمية بشرية','economic:اقتصاد','social:تنمية اجتماعية','natural_resources:موارد طبيعية']],
['quality_status','حالات الجودة والمراجعة',['verified:متحقق','unverified:غير متحقق','incomplete:غير مكتمل','accepted:معتمد','rejected:مرفوض','pending:قيد المراجعة']],
['education_level','المراحل التعليمية',['kindergarten:رياض أطفال','basic:أساسي','secondary:ثانوي','literacy:محو أمية']],
['sex','الجنس',['male:ذكر','female:أنثى','unknown:غير محدد']],
['project_type','أنواع المشاريع',['water:مياه','road:طرق','health:صحي','education:تعليمي','productive:إنتاجي','humanitarian:إنساني','multi:متعدد']],
['occupation','المهن',['public_employee:موظف حكومي','private_employee:موظف خاص','farmer:مزارع','fisher:صياد','trader:تاجر','craft:حرفي','other:أخرى']],
['ownership','أنواع الملكية',['public:حكومي','private:خاص','community:مجتمعي','cooperative:تعاوني','mixed:مختلط']],
['case_status','الحالات التشغيلية',['active:نشط','inactive:غير نشط','partial:جزئي','closed:مغلق','unknown:غير محدد']],
['disability_type','أنواع الإعاقة',['mobility:حركية','visual:بصرية','hearing:سمعية','speech:نطقية','other:أخرى']],
['social_group','الشرائح الاجتماعية',['employee:موظفون','trader:تجار','agricultural_worker:عمالة زراعية','fisher:صيادون','construction_worker:عمال بناء','craft_worker:حرفيون','other:أخرى']],
['occupation','المهن',['public_employee:موظف حكومي','private_employee:موظف خاص','farmer:مزارع','fisher:صياد','trader:تاجر','craft:حرفي','other:أخرى']],
['housing_type','أنواع السكن',['house:منزل','rented:إيجار','temporary:مؤقت','tent:خيمة','other:أخرى']],
['payment_cycle','دورات الصرف',['monthly:شهري','quarterly:ربع سنوي','semiannual:نصف سنوي','annual:سنوي','one_time:مرة واحدة']],
['wind_direction','اتجاه الرياح',['north:شمال','south:جنوب','east:شرق','west:غرب','variable:متغير']],
['building_type','أنواع المباني',['school_building:مبنى مدرسي','rented_house:مسكن','shed:عشة أو صندقة','tent:خيمة','tree:تحت الشجرة','other:أخرى']],
['specialty','التخصصات',['arabic:لغة عربية','english:لغة إنجليزية','mathematics:رياضيات','science:علوم','physics:فيزياء','chemistry:كيمياء','biology:أحياء','history:تاريخ','geography:جغرافيا','other:أخرى']],
['sport_type','الرياضات',['football:كرة القدم','volleyball:كرة الطائرة','basketball:كرة السلة','other:أخرى']],
['crop_type','أنواع المحاصيل',['coffee:بن','qat:قات','wheat:قمح','sorghum:ذرة رفيعة','maize:ذرة','vegetables:خضروات','fruit:فواكه','other:أخرى']],
['irrigation_type','أنواع الري',['rainfed:مطري','wells:آبار','flood:سيول','springs:غيول وعيون','drip:تنقيط','other:أخرى']],
['animal_disease','الأمراض الحيوانية',['parasites:طفيليات','viral:فيروسية','bacterial:بكتيرية','other:أخرى']],
['fishery_zone','مناطق الصيد',['coastal:ساحلية','offshore:بحرية','inland:داخلية']],
['economic_activity','الأنشطة الاقتصادية',['agriculture:زراعة','livestock:ثروة حيوانية','fisheries:صيد','manufacturing:تصنيع','retail:تجارة','transport:نقل','hospitality:ضيافة وسياحة','crafts:حرف']],
['tourism_type','أنواع المواقع السياحية',['natural:طبيعي','historical:تاريخي','cultural:ثقافي','coastal:ساحلي']],
['accessibility','إمكانية الوصول',['easy:سهلة','moderate:متوسطة','difficult:صعبة','seasonal:موسمية']],
['heritage_type','أنواع الموروث',['dance:رقصات شعبية','poetry:شعر وزامل','craft:حرف ومصنوعات','custom:عادات وتقاليد']],
['indicator_direction','اتجاه المؤشر',['higher_better:القيمة الأعلى أفضل','lower_better:القيمة الأقل أفضل','target:القرب من المستهدف']],
['swot_type','عناصر SWOT',['strength:قوة','weakness:ضعف','opportunity:فرصة','threat:تهديد']],
['pestle_dimension','أبعاد PESTLE',['political:سياسي وحوكمي','economic:اقتصادي','social:اجتماعي','technological:تقني','legal:قانوني وتشريعي','environmental:بيئي']],
['priority_level','مستويات الأولوية',['critical:عالية جداً','high:عالية','medium:متوسطة','low:منخفضة']]
];

const ENTITY_TYPES = [
['school','مدرسة'],['health_facility','مرفق صحي'],['water_project','مشروع مياه'],['road','طريق'],
['government_office','مكتب حكومي'],['organization','منظمة أو جمعية'],['economic_establishment','منشأة اقتصادية'],
['tourism_site','موقع سياحي'],['cultural_asset','مورد ثقافي'],['agricultural_producer','منتج زراعي'],
['fisheries_operator','جهة عاملة في الصيد'],['partner','شريك تنموي']
];

function norm(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g,'')
    .replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
    .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ').toLowerCase();
}
function seedUnits(db,now) {
  const insert=db.prepare('INSERT OR IGNORE INTO measurement_units(unit_code,name_ar,unit_category,created_at) VALUES(?,?,?,?)');
  const all=[['percent','نسبة','ratio'],['km2','كيلومتر مربع','area'],['hectare','هكتار','area'],['celsius','درجة مئوية','temperature'],['millimeter','ملليمتر','length'],['m3','متر مكعب','volume'],['kg','كيلوجرام','mass'],['household','أسرة','count'],['case','حالة','count'],['currency','عملة','currency'],['tonne_per_hectare','طن/هكتار','yield']];
  all.forEach(x=>insert.run(...x,now));
}
function seedDimensions(db,now) {
  const dims=[
    ['sex','الجنس',['male:ذكر','female:أنثى','unknown:غير محدد']],
    ['age_group','الفئة العمرية',['0_5:0–5 سنوات','6_14:6–14 سنة','15_17:15–17 سنة','18_60:18–60 سنة','61_plus:61 سنة فأكثر']],
    ['education_level','المستوى التعليمي',['none:بدون تعليم','basic:أساسي','secondary:ثانوي','diploma:دبلوم','bachelor:بكالوريوس','postgraduate:دراسات عليا']],
    ['urban_rural','التصنيف الحضري والريفي',['urban:حضري','rural:ريفي']]
  ];
  const add=db.prepare('INSERT OR IGNORE INTO dimension_definitions(dimension_code,name_ar,description,dimension_type,is_active,created_at) VALUES(?,?,? ,\'reference\',1,?)');
  const get=db.prepare('SELECT dimension_id FROM dimension_definitions WHERE dimension_code=?');
  const val=db.prepare('INSERT OR IGNORE INTO dimension_values(dimension_id,value_code,label_ar,sort_order,is_active,created_at) VALUES(?,?,?,?,1,?)');
  for(const [code,label,values] of dims){add.run(code,label,'تصنيف تحليلي مشترك.',now);const id=get.get(code).dimension_id;values.forEach((v,i)=>{const [k,n]=v.split(':');val.run(id,k,n,i,now);});}
}
function seedRefs(db,now) {
  const add=db.prepare('INSERT OR IGNORE INTO reference_sets(set_code,name_ar,description,is_hierarchical,is_active,created_at,updated_at) VALUES(?,?,?,0,1,?,?)');
  const get=db.prepare('SELECT reference_set_id FROM reference_sets WHERE set_code=?');
  const value=db.prepare('INSERT OR IGNORE INTO reference_values(reference_set_id,value_code,label_ar,sort_order,is_active,created_at) VALUES(?,?,?,?,1,?)');
  for(const [code,label,values] of REFS){add.run(code,label,'قائمة تصنيف مشتركة موحدة.',now,now);const id=get.get(code).reference_set_id;values.forEach((item,i)=>{const [v,n]=item.split(':');value.run(id,v,n,i,now);});}
}
function seedEntities(db,now) {
  const insert=db.prepare('INSERT OR IGNORE INTO entity_types(entity_type_code,name_ar,is_active,created_at) VALUES(?,?,1,?)');
  ENTITY_TYPES.forEach(x=>insert.run(x[0],x[1],now));
}
function fieldGroup(db,code,parent,level,name,order,now) {
  db.prepare('INSERT OR IGNORE INTO field_groups(group_code,parent_group_id,group_level,name_ar,sort_order,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
    .run(code,parent,level,name,order,now,now);
  return db.prepare('SELECT group_id FROM field_groups WHERE group_code=?').get(code).group_id;
}
function seedCatalog(db,now) {
  const getUnit=db.prepare('SELECT unit_id FROM measurement_units WHERE unit_code=?');
  const getRef=db.prepare('SELECT reference_set_id FROM reference_sets WHERE set_code=?');
  const addField=db.prepare('INSERT OR IGNORE INTO field_definitions(field_code,canonical_name_ar,semantic_type,data_type,default_unit_id,reference_set_id,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)');
  const getField=db.prepare('SELECT field_definition_id FROM field_definitions WHERE field_code=?');
  const link=db.prepare('INSERT OR IGNORE INTO field_group_fields(group_id,field_definition_id,sort_order,is_primary,created_at) VALUES(?,?,?,1,?)');
  const alias=db.prepare('INSERT OR IGNORE INTO field_definition_aliases(field_definition_id,alias_text,normalized_alias,locale,is_approved,match_method,confidence,created_at) VALUES(?,?,?,\'ar\',1,\'curated\',1,?)');
  const dimRule=db.prepare('INSERT OR IGNORE INTO field_dimension_rules(field_definition_id,dimension_id,axis_role,is_required,sort_order,created_at) SELECT ?,dimension_id,\'breakdown\',0,0,? FROM dimension_definitions WHERE dimension_code=?');
  const legacy={
    'governorate.name':'directorate.governorate','directorate.name':'directorate.districtName',
    'population.rural':'directorate.ruralPopulation','projects.cost':'directorate.projectCost','projects.status':'directorate.projectStatus',
    'population.total':'directorate.population','population.density':'directorate.densityPerKm2',
    'water.coverage_rate':'directorate.waterCoverage','roads.paved_share':'directorate.pavedRoads',
    'finance.revenue.collected':'directorate.revenue','education.school.count':'directorate.schools',
    'education.enrollment.total':'directorate.enrolledStudents','agriculture.crop.production':'directorate.agriProduction',
    'agriculture.livestock.headcount':'directorate.livestockHeads','governance.organization.associations':'directorate.associations',
    'protection.assistance.goods_tons':'directorate.goodsTons','protection.front_line':'directorate.frontLine',
    'poverty.rate':'directorate.povertyRatio','metadata.reviewer_decision':'directorate.reviewerDecision'
  };
  const dimFields={
    'population.total':'sex,age_group','population.male':'age_group','population.female':'age_group',
    'population.age_sex':'sex,age_group','education.population_school_age':'sex,age_group',
    'education.enrollment.total':'sex,age_group','education.enrollment.rate':'sex,age_group',
    'education.dropout.count':'sex,age_group','education.dropout.rate':'sex,age_group',
    'health.disease.cases':'sex,age_group','health.staff.physicians':'sex','health.staff.nurses':'sex',
    'health.staff.technicians':'sex','education.staff.teachers':'sex'
  };
  let domainOrder=0;
  for(const [domainCode,domainName,children] of CATALOG){
    const root=fieldGroup(db,domainCode,null,'domain',domainName,domainOrder++,now);
    let subgroupOrder=0;
    for(const [subCode,subName,fields] of children){
      const child=fieldGroup(db,domainCode+'.'+subCode,root,'subdomain',subName,subgroupOrder++,now);
      fields.forEach((entry,i)=>{
        const parts=entry.split('|');
        const wanted=parts[0],label=parts[1],dataType=parts[2]||'text',unitCode=parts[3]||null,refCode=parts[4]||null;
        const code=legacy[wanted]||wanted;
        const unitId=unitCode ? (getUnit.get(unitCode)?.unit_id??null) : null;
        const refId=refCode ? (getRef.get(refCode)?.reference_set_id??null) : null;
        const semantic=['integer','decimal'].includes(dataType)?'measurement':dataType==='long_text'?'narrative':dataType==='reference'?'classification':'attribute';
        addField.run(code,label,semantic,dataType,unitId,refId,now,now);
        const fieldId=getField.get(code).field_definition_id;
        link.run(child,fieldId,i,now);
        alias.run(fieldId,label,norm(label),now);
        const dims=(dimFields[wanted]||'').split(',').filter(Boolean);
        for(const d of dims) dimRule.run(fieldId,now,d);
      });
    }
  }
  const all=db.prepare('SELECT field_definition_id,canonical_name_ar FROM field_definitions WHERE canonical_name_ar IS NOT NULL').all();
  for(const f of all) alias.run(f.field_definition_id,f.canonical_name_ar,norm(f.canonical_name_ar),now);
}
function seedPriority(db,now) {
  const rows=[['severity','شدة الأثر',0.25],['scale','اتساع المشكلة',0.20],['urgency','الإلحاح',0.20],['affected_population','السكان المتأثرون',0.15],['feasibility','قابلية المعالجة',0.10],['equity','الإنصاف',0.10]];
  const insert=db.prepare('INSERT OR IGNORE INTO priority_criteria(criterion_code,name_ar,default_weight,direction,is_active,created_at,updated_at) VALUES(?,?,?,\'higher_is_higher\',1,?,?)');
  rows.forEach(x=>insert.run(...x,now,now));
}
function modelDefinitionJson() {
  return JSON.stringify({CATALOG,LEGACY,UNITS,DIMS,REFS,ENTITY_TYPES});
}
function checksums() {
  return migrationIntegrity.migrationChecksums({ text: fs.readFileSync(SQL_FILE, 'utf8'), definition: modelDefinitionJson() });
}
function checksum() {
  return checksums().canonical;
}
function migrateSeedPolicy(db) {
  const version=2;
  const code='unified-development-model-seed-policy-v2';
  const seededWeights=[['severity',0.25],['scale',0.20],['urgency',0.20],['affected_population',0.15],['feasibility',0.10],['equity',0.10]];
  const catalogAliases=[...new Set(CATALOG.flatMap(([, ,children])=>children.flatMap(([, ,fields])=>fields.map(entry=>norm(entry.split('|')[1])))))];
  const provenanceRule='only-rows-created-by-development-model-migration-v1';
  const seedChecksums=migrationIntegrity.migrationChecksums({text:fs.readFileSync(SQL_FILE,'utf8'),definition:modelDefinitionJson(),suffix:code+JSON.stringify(seededWeights)+JSON.stringify(catalogAliases)+provenanceRule});
  const hash=seedChecksums.canonical;
  const previous=db.prepare('SELECT * FROM development_model_migrations WHERE version=?').get(version);
  if(previous?.success===1){
    migrationIntegrity.verifyAppliedMigration(db,{table:'development_model_migrations',version,recorded:previous.checksum,checksums:seedChecksums,label:code});
    return {version,alreadyApplied:true};
  }
  if(previous)db.prepare('DELETE FROM development_model_migrations WHERE version=? AND success=0').run(version);
  const now=new Date().toISOString();
  const seedTimestamp=db.prepare('SELECT applied_at FROM development_model_migrations WHERE version=1 AND success=1').get()?.applied_at;
  if(!seedTimestamp)throw new Error('تعذر تحديد توقيت بذور نموذج البيانات للتحقق من مصدرها.');
  try{
    db.transaction(()=>{
      const aliases=db.prepare(`SELECT alias.alias_id,alias.normalized_alias FROM field_definition_aliases alias
        WHERE alias.is_approved=1 AND alias.match_method='curated' AND alias.confidence=1 AND alias.created_at=?
          AND alias.normalized_alias IN (${catalogAliases.map(()=>'?').join(',')})
          AND EXISTS (SELECT 1 FROM field_group_fields link JOIN field_groups group_definition USING(group_id)
            WHERE link.field_definition_id=alias.field_definition_id AND group_definition.group_level='subdomain')`).all(seedTimestamp,...catalogAliases);
      const unapprove=db.prepare(`UPDATE field_definition_aliases SET is_approved=0,match_method='unverified_catalog_label',confidence=0 WHERE alias_id=? AND normalized_alias=?`);
      for(const alias of aliases)unapprove.run(alias.alias_id,alias.normalized_alias);
      const deactivate=db.prepare(`UPDATE priority_criteria SET default_weight=0,is_active=0
        WHERE criterion_code=? AND default_weight=? AND is_active=1 AND created_at=? AND updated_at=?`);
      for(const [criterion,weight] of seededWeights)deactivate.run(criterion,weight,seedTimestamp,seedTimestamp);
      const foreignKeys=db.prepare('PRAGMA foreign_key_check').all();
      if(foreignKeys.length)throw new Error('مخالفة مفاتيح خارجية في ترحيل سياسة البذور: '+JSON.stringify(foreignKeys.slice(0,8)));
      db.prepare('INSERT INTO development_model_migrations(version,migration_code,checksum,applied_at,success,details) VALUES(?,?,?,?,1,?)')
        .run(version,code,hash,now,'تعطيل الاعتماد التلقائي لأسماء الحقول، وتصفير الأوزان الافتراضية غير المعتمدة دون حذف التقييمات.');
    })();
    return {version,alreadyApplied:false};
  }catch(error){
    db.prepare('INSERT OR REPLACE INTO development_model_migrations(version,migration_code,checksum,applied_at,success,details) VALUES(?,?,?,?,0,?)')
      .run(version,code,hash,new Date().toISOString(),String(error.message).slice(0,4000));
    throw error;
  }
}
function migrate(db) {
  const sql=fs.readFileSync(SQL_FILE,'utf8');
  db.exec('CREATE TABLE IF NOT EXISTS development_model_migrations(version INTEGER PRIMARY KEY,migration_code TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL,applied_at TEXT NOT NULL,success INTEGER NOT NULL CHECK(success IN (0,1)),details TEXT)');
  const hash=checksum();
  const previous=db.prepare('SELECT * FROM development_model_migrations WHERE version=?').get(VERSION);
  const sourceChecksums=checksums();
  if(previous?.success===1){migrationIntegrity.verifyAppliedMigration(db,{table:'development_model_migrations',version:VERSION,recorded:previous.checksum,checksums:sourceChecksums,label:CODE});}
  else {
    if(previous)db.prepare('DELETE FROM development_model_migrations WHERE version=? AND success=0').run(VERSION);
    const now=new Date().toISOString();
    try{
      db.transaction(()=>{
        db.exec(sql);
        seedUnits(db,now);seedDimensions(db,now);seedRefs(db,now);seedEntities(db,now);seedCatalog(db,now);seedPriority(db,now);
        const fk=db.prepare('PRAGMA foreign_key_check').all();
        if(fk.length)throw new Error('مخالفة مفاتيح خارجية في ترحيل نموذج البيانات: '+JSON.stringify(fk.slice(0,8)));
        db.prepare('INSERT OR REPLACE INTO development_model_migrations(version,migration_code,checksum,applied_at,success,details) VALUES(?,?,?,?,1,?)')
          .run(VERSION,CODE,hash,now,'إضافة النموذج الموحد بشكل تراكمي دون حذف الجداول أو السجلات السابقة.');
      })();
    }catch(error){
      db.prepare('INSERT OR REPLACE INTO development_model_migrations(version,migration_code,checksum,applied_at,success,details) VALUES(?,?,?,?,0,?)')
        .run(VERSION,CODE,hash,new Date().toISOString(),String(error.message).slice(0,4000));
      throw error;
    }
  }
  return migrateSeedPolicy(db);
}
module.exports={migrate,checksum,VERSION,CODE,CATALOG};
