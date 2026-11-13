'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUTPUT_PATH = path.resolve(__dirname, '../../docs/architecture/manual-entry-requirement-register.csv');
const SPECIFICATION_VERSION = 'user-brief-2026-11-12';
const SPECIFICATION_ITEMS = Object.freeze({
  'administrative-geography.administrative-units': [
    'اسم المحافظة ورمزها', 'اسم المديرية ورمزها ومركزها', 'اسم العزلة ورمزها وموقعها داخل المديرية',
    'اسم التجمع السكاني ورمزه', 'اسم القرية ورمزها', 'اسم المحلة والحارة', 'عدد العزل والقرى والمحلات والحارات',
    'المساحة الكلية للمديرية ومساحة العزلة', 'المسافة عن مركز المحافظة ومركز المديرية',
    'الحدود الشمالية والجنوبية والشرقية والغربية', 'طبيعة الطرق المؤدية للعزلة',
  ],
  'administrative-geography.representation-and-constituencies': [
    'عدد الدوائر النيابية والمحلية والانتخابية', 'رقم الدائرة الانتخابية', 'عدد المراكز الانتخابية', 'عدد أعضاء السلطة المحلية',
  ],
  'population-households.population': [
    'إجمالي السكان والذكور والإناث', 'التوزيع النسبي حسب الجنس', 'السكان حسب الفئة العمرية',
    'السكان حسب تقاطع العمر والجنس', 'الكثافة السكانية',
  ],
  'population-households.age-groups': [
    'عدد السكان من 0 إلى 5 سنوات حسب الجنس عند توفره', 'عدد السكان من 6 إلى 14 سنة حسب الجنس عند توفره',
    'عدد السكان من 15 إلى 17 سنة حسب الجنس عند توفره', 'عدد السكان من 18 إلى 60 سنة حسب الجنس عند توفره',
    'عدد السكان من 61 سنة فأكثر حسب الجنس عند توفره',
  ],
  'population-households.households-and-housing': [
    'إجمالي الأسر والمساكن', 'نسبة المساكن ونسبة الأسر', 'الأسر حسب التجمع والعزلة', 'المساكن حسب التجمع والعزلة',
  ],
  'poverty-livelihoods.poverty': [
    'عدد ونسبة الأسر تحت خط الفقر الأعلى', 'عدد ونسبة الأسر تحت خط الفقر الأدنى', 'معايير احتساب الفقر',
    'مستوى الفقر حسب التجمع والقرية', 'الأسر حسب شريحة الرفاه',
  ],
  'poverty-livelihoods.social-and-occupational-groups': [
    'نوع الشريحة الاجتماعية ونوع المهنة', 'عدد أفراد الشريحة', 'نسبة الذكور والإناث',
    'تصنيفات الموظفين والتجار والعمالة الزراعية والصيادين وعمال البناء والحرفيين والمهن الأخرى',
  ],
  'poverty-livelihoods.income-and-livelihoods': [
    'مستوى دخل الأسرة ومستوى إنفاقها', 'قيمة ونسبة المدخلات الأسرية', 'قيمة ونسبة المخرجات الأسرية',
  ],
  'poverty-livelihoods.assets-and-ownership': [
    'امتلاك وظيفة حكومية ووسيلة نقل', 'نوع السكن وملكيته', 'امتلاك الأراضي',
    'امتلاك الأغنام والماعز والأبقار', 'المساحات الزراعية وخلايا النحل والأصول الأخرى',
  ],
  'target-groups-protection.persons-with-disabilities': [
    'إجمالي الأشخاص ذوي الإعاقة وعددهم حسب النوع والجنس', 'نسبة كل نوع ونسبتهم من السكان',
    'نوع الإعاقة وحالتها وأسبابها', 'المشاركة المجتمعية والأنشطة الاقتصادية ومجالات العمل',
    'مصادر الدخل والخدمات والرعاية الصحية', 'المشكلات والحلول', 'تصنيفات الإعاقة الحركية والبصرية والسمعية والنطقية والأخرى',
  ],
  'target-groups-protection.displacement': [
    'تاريخ النزوح وأسبابه وأماكن التواجد', 'حالة الاستقرار ونمط السكن وإمكانية العودة',
    'الأنشطة الاقتصادية ومجالات العمل ومصادر الدخل', 'المشاركة المجتمعية والخدمات الصحية والمياه',
    'المشاريع المقدمة والبيانات الإضافية', 'المشكلات والحلول',
  ],
  'target-groups-protection.assistance-and-social-protection': [
    'عدد الأسر والحالات المستحقة وعدد المستفيدين فعلياً', 'الأسر الفقيرة غير المستفيدة',
    'الجهة الداعمة والمبلغ المنصرف ودورة الصرف',
  ],
  'natural-resources-environment.terrain': [
    'عدد وأسماء الجبال والمرتفعات والوديان والمنحدرات', 'نسبة مساحة الجبال والوديان من مساحة العزلة',
    'اسم المقطع الطبيعي ونسبة استخدامه ومجال استخدامه', 'الفرص والتحديات المرتبطة بالتضاريس',
  ],
  'natural-resources-environment.climate': [
    'الموقع المداري', 'الرطوبة في الشتاء والصيف', 'درجات الحرارة في الشتاء والصيف',
    'موسم الأمطار ومتوسط هطول الأمطار', 'موسم الرياح واتجاهها',
  ],
  'natural-resources-environment.soil-and-land': [
    'نوع التربة', 'مساحة التربة الرملية والحصوية والكلسية والطينية', 'مساحة الكثبان الرملية',
    'المساحة الصالحة للزراعة والمساحة الكلية', 'مساحة الغطاء النباتي', 'طبيعة الأرض وملكيتها',
  ],
  'natural-resources-environment.water-resources': [
    'متوسط هطول الأمطار واستخدام مياه الأمطار', 'الغيول الجوفية والسطحية والعيون السطحية والجوفية',
    'الآبار وأنواع المياه وسعة الآبار واستخدامها', 'سعة الحواجز والسدود واستخدامها',
    'مشكلات مصادر المياه وفرص تحسينها',
  ],
  'natural-resources-environment.vegetation': [
    'أنواع الأشجار والشجيرات والأشجار المثمرة', 'النباتات الاقتصادية والبرية', 'مساحة الأراضي المغطاة بالنباتات',
  ],
  'natural-resources-environment.wildlife-and-marine-life': [
    'الحيوانات البرية والطيور', 'المنطقة الساحلية والأحياء البحرية والمخزون السمكي',
    'فرص استغلال الأحياء البحرية', 'المشكلات والحلول', 'دور المجتمع والجمعيات والحكومة في الحماية',
  ],
  'natural-resources-environment.environmental-degradation': [
    'حدة التصحر وانجراف التربة', 'تدهور مساقط المياه والمدرجات الزراعية وجوانب الأودية والغطاء النباتي',
    'استنزاف المياه الجوفية وتلوثها', 'تدهور الموارد البحرية',
  ],
  'society-culture-heritage.social-structure': [
    'نوع التركيبة الاجتماعية ومتغيراتها', 'درجة التعاون والاختلاف والسيطرة أو النفوذ المجتمعي',
    'الأثر الإيجابي والسلبي على التنمية',
  ],
  'society-culture-heritage.customs-and-traditions': [
    'اسم العادة ووصفها وحالتها', 'أسباب الاندثار والعوامل المؤثرة وأسباب انخفاض الممارسة',
    'الآثار السلبية والتوصيات',
  ],
  'society-culture-heritage.cultural-heritage': [
    'اسم الموروث ونوعه وطبيعته ووصفه', 'موسم التنفيذ أو الممارسة', 'الوضع الحالي',
  ],
  'society-culture-heritage.social-influencers': [
    'اسم الشخصية الاجتماعية أو النافذة', 'صفتها ونوعها ووصفها', 'المميزات والعيوب', 'طرق توظيفها تنموياً',
  ],
  'local-governance-institutions.local-representation': [
    'عدد أعضاء السلطة المحلية حسب المؤهل العلمي والجنس', 'المستوى التعليمي والتوزيع النسبي حسب المؤهل والجنس',
    'أعضاء وممثلو الهيئات المحلية',
  ],
  'local-governance-institutions.executive-administration': [
    'اسم الإدارة والقسم والجهاز التنفيذي والمرفق الحكومي', 'تاريخ التأسيس',
    'القوى العاملة حسب الجنس والرسميون والمتعاقدون والعدد اللازم',
    'المستوى التعليمي والمؤهلات', 'ملاحظات الموارد البشرية والإدارة',
  ],
  'local-governance-institutions.community-institutions': [
    'اسم المؤسسة ونوعها ومكانها وغرضها', 'رأي المجتمع', 'سنة التأسيس',
  ],
  'local-governance-institutions.associations-and-cooperatives': [
    'اسم الجمعية ونوعها ونشاطها ومكانها وتاريخ تأسيسها', 'الأنشطة وعدد الأعضاء حسب الجنس والمشاريع',
    'المساهمون والأسهم ورأس المال', 'أعضاء الهيئتين الإدارية والتنفيذية واكتمال البناء المؤسسي',
    'الأصول والأنشطة الاقتصادية والاجتماعية والملاحظات',
  ],
  'local-governance-institutions.partners-and-actors': [
    'نوع الفاعل وعدد الفاعلين النشطين وغير النشطين واحتياجاتهم',
    'اسم الشريك وتاريخ بداية العمل ومجال التدخل والجهة المنسقة',
  ],
  'local-governance-institutions.community-priorities': [
    'الأولويات المجتمعية', 'معايير التفضيل وعدم التفضيل',
  ],
  'education-literacy.kindergartens': [
    'عدد الأطفال في سن الالتحاق وعدد رياض الأطفال', 'الملتحقون حسب الجنس ونسبة الالتحاق', 'عدد المربيات',
  ],
  'education-literacy.schools-and-facilities': [
    'اسم المدرسة ونوعها والمرحلة وجنس المدرسة', 'عدد الصفوف والشعب والشعب حسب الفترة وعدد الفترات',
    'نوع المبنى وحالته', 'المدارس حسب نوع المبنى والحالة الإنشائية',
  ],
  'education-literacy.enrollment-and-students': [
    'السكان في سن التعليم الأساسي والثانوي حسب الجنس وإجمالي كل فئة',
    'الملتحقون حسب المرحلة والجنس ونسبة الالتحاق', 'الطلاب حسب المرحلة والصف والجنس',
    'المسار العلمي والأدبي والجنس', 'الفترة الدراسية والجنس',
  ],
  'education-literacy.dropout': [
    'عدد المتسربين ونسبة التسرب حسب الجنس والمرحلة والصف',
  ],
  'education-literacy.education-workforce': [
    'المعلمون حسب التخصص والجنس', 'مديرو المدارس والوكلاء والسكرتارية وأمناء المكتبات والمختبرات',
    'العاملون الإداريون والكادر من أبناء المديرية وخارجها', 'المدرسون والمدرسات حسب المؤهل', 'الملاحظات',
  ],
  'education-literacy.education-specializations': [
    'القرآن الكريم والتربية الإسلامية والعربية والإنجليزية والرياضيات',
    'الفيزياء والكيمياء والأحياء والجغرافيا والتاريخ والاجتماع وعلم النفس والفلسفة',
    'العلوم والاجتماعيات والتخصصات الأخرى',
  ],
  'education-literacy.literacy': [
    'طبيعة نشاط مركز محو الأمية', 'السكان من 18 إلى 60 حسب الجنس والأميون حسب الجنس ونسب الأمية',
    'عدد المراكز والصفوف والملتحقين حسب الجنس', 'نسب الالتحاق والإجماليات',
  ],
  'health-population-services.health-facilities': [
    'اسم المرفق ونوعه وعدد المرافق حسب النوع', 'اكتمال التجهيزات وحالة التشغيل', 'الخدمات والأنشطة الصحية',
  ],
  'health-population-services.health-coverage': [
    'السكان المخدومون والسكان المغطون ونسبة التغطية',
    'المترددون حسب الجنس ونسبهم وإجمالي المترددين',
  ],
  'health-population-services.diseases': [
    'نوع المرض وعدد الحالات حسب المرض وإجمالي الحالات',
    'الملاريا والإسهالات والبلهارسيا المعوية والبولية والطفيليات المعوية والسل والحصبة والتهاب الكبد والأمراض الجلدية والأخرى',
  ],
  'health-population-services.maternal-child-and-immunization': [
    'وفيات الأطفال الرضع ودون الخامسة ووفيات الأمهات عند الولادة',
    'الأطفال المستهدفون والملقحون دون الخامسة',
    'النساء الحوامل المستفيدات من خدمات الصحة الإنجابية والمستفيدون من خدمات الأمومة والطفولة',
  ],
  'health-population-services.health-workforce': [
    'الأطباء الاختصاصيون والعموميون ومساعدو الأطباء', 'الممرضون والممرضات والفنيون والفنيات',
    'قابلات المجتمع والعاملون الآخرون حسب الجنس حيثما توفر القياس',
  ],
  'culture-youth-sports.culture-youth-and-sports-facilities': [
    'المكتبات والمتاحف والمراكز والمرافق الثقافية', 'المراكز الشبابية والمنشآت الرياضية',
    'الفرق الرياضية وأنواعها وأنشطة كرة القدم والطائرة والسلة والأنشطة الأخرى',
  ],
  'infrastructure-basic-services.water-supply': [
    'اسم مشروع المياه والقرى المستفيدة وسكان المنطقة المستفيدة والمستفيدون',
    'ملكية المشروع ومكوناته وحالته', 'المساكن المزودة بمياه الشرب حسب المصدر والنسب والإجمالي',
  ],
  'infrastructure-basic-services.sanitation-environmental-health': [
    'المساكن المرتبطة بشبكة الصرف الصحي والنسب', 'المسالخ ومقالب المخلفات ومعدات النقل',
    'عمال صحة البيئة والسكان المتأثرون',
  ],
  'infrastructure-basic-services.electricity-and-energy': [
    'مصدر الكهرباء والمساكن المزودة حسب المصدر ونسب التغطية والإجمالي',
    'المصادر المركزية والتعاونية والأهلية والطاقة الشمسية والمصادر الأخرى',
  ],
  'infrastructure-basic-services.roads': [
    'اسم الطريق والمشروع ونوع السطح والتصنيف والطول والحالة',
    'القرى والتجمعات المستفيدة والسكان المستفيدون', 'السطح الإسفلتي والحصوي والترابي والتصنيف الدولي والوطني والمحلي',
  ],
  'infrastructure-basic-services.telecommunications': [
    'سعة السنترال وخطوط الهاتف وعدد المشتركين', 'نسبة السعة المجهزة واستغلالها والتغطية الكلية',
  ],
  'agriculture-irrigation-livestock-fisheries.water-harvesting-and-irrigation': [
    'اسم البركة والسد والحاجز وعدد المنشآت والسعة التخزينية', 'الاستخدامات الرئيسية والفرعية والحالة',
    'المساحة المروية ونظام الري والمحاصيل المروية', 'المستفيدون والحائزون',
  ],
  'agriculture-irrigation-livestock-fisheries.agricultural-land-and-holdings': [
    'إجمالي المساحة والصالح للزراعة والمزروع', 'الحائزون والعاملون حسب الجنس',
    'المساحة حسب مصدر الري: الأمطار والآبار والسيول والغيول والسدود والحواجز والمياه المنقولة وغيرها',
  ],
  'agriculture-irrigation-livestock-fisheries.livestock': [
    'المربون حسب الجنس ومتوسط الحيازة حسب الحيوان', 'المراكز البيطرية والأطباء ومحطات البحوث',
    'نوع الحيوان والأمراض الشائعة ومعدل الإصابة والمواسم والوفيات وطرق العلاج والجهة المسؤولة',
    'الماعز والأغنام والأبقار والجمال والحمير وغيرها',
  ],
  'agriculture-irrigation-livestock-fisheries.poultry': [
    'المربون ومستأجرو المزارع والمزارع والعنابر', 'غرض التربية',
    'إنتاج دجاج اللحم والبيض سنوياً والعاملون',
  ],
  'agriculture-irrigation-livestock-fisheries.beekeeping-and-honey': [
    'المربون وعدد الخلايا ونوع الخلية', 'متوسط إنتاج الخلية في الموسم',
    'إجمالي إنتاج العسل حسب النوع والإجمالي وسعر الكيلو وإجمالي العائد',
  ],
  'agriculture-irrigation-livestock-fisheries.crops': [
    'نوع المحصول وفئته والمساحة المزروعة والإنتاجية للهكتار وكمية الإنتاج',
    'الحبوب والخضروات والفواكه والبقوليات والمحاصيل النقدية والأعلاف والبن والقات والأشجار الأخرى',
  ],
  'agriculture-irrigation-livestock-fisheries.plants-and-plant-products': [
    'أنواع النباتات وطبيعة الأراضي وملكيتها', 'العاملون حسب الجنس',
    'المنتجات ووحدة القياس وسعر الوحدة والإنتاج السنوي والعائد ومناطق التسويق',
  ],
  'agriculture-irrigation-livestock-fisheries.agricultural-services': [
    'عدد مراكز الخدمات ونوع الخدمات', 'العاملون والعاملات والمستفيدون والمستفيدات والنسب',
  ],
  'agriculture-irrigation-livestock-fisheries.product-marketing': [
    'نوع المنتج ومنطقة التسويق والكمية المسوقة', 'التخزين المبرد وآليات التسويق وتسهيلات البيع',
  ],
  'agriculture-irrigation-livestock-fisheries.fisheries-and-fishing': [
    'مناطق الصيد والقوارب حسب مادة الصنع وملاك القوارب والمشتغلون',
    'مواسم الصيد والإنتاج السمكي والصادرات', 'الجمعيات والشركات وتسويق المنتجات',
  ],
  'agriculture-irrigation-livestock-fisheries.fishing-facilities': [
    'مواقع الإنزال والموانئ والمراسي وكواسر الأمواج',
    'ساحات المزاد ومعامل الثلج والثلاجات ومصانع التعليب',
  ],
  'industry-private-sector-tourism.industry': [
    'نوع وعدد المنشآت وحجم وقيمة الإنتاج وأماكن التسويق', 'العاملون حسب الجنس والمنتج الصناعي',
    'معامل التصنيع والمواد الخام ومصادرها وكميات الإنتاج وقيمته والتسويق',
  ],
  'industry-private-sector-tourism.commercial-and-service-establishments': [
    'أنواع المنشآت المهنية والتجارية والخدمية وعددها حسب النشاط', 'العاملون حسب الجنس والنشاط الاقتصادي والملاحظات',
    'معامل المعاوز وورش النجارة والحدادة والألمنيوم والخياطة والمحلات التجارية والغذائية والغاز والقرطاسية وقطع الغيار',
    'الميكانيكا والسمكرة وصيانة السيارات ومصانع الأحجار والرخام والبلاط ومحطات الوقود ومعاصر السمسم والاتصالات',
    'المطاعم والفنادق واللوكندات والبوفيات والتصوير والحلاقة والأنشطة الأخرى',
  ],
  'industry-private-sector-tourism.tourism': [
    'اسم الموقع ووصفه وإمكانية الوصول', 'عدد الزوار المواطنين والأجانب والإجمالي',
    'سنة أو فترة قياس الزوار', 'نوع المنشأة السياحية وعدد المنشآت والملاحظات',
  ],
  'projects-finance-revenues.projects': [
    'مجال وقطاع المشروع والعدد الإجمالي', 'مساهمة المجتمع والسلطة المحلية ووحدة التدخلات والتكلفة الإجمالية',
    'العزل المشمولة ونسب المساهمة ومستوى الإنجاز الفعلي', 'المشاريع حسب المجال والاعتماد المالي والإنفاق الفعلي حسب السنة والإنجاز الفني',
  ],
  'projects-finance-revenues.project-funding': [
    'مصادر التمويل ومساهمات المجتمع والسلطة المحلية ووحدة التدخلات',
    'الاعتماد والإنفاق الفعلي حسب السنة المالية', 'قيمة المساهمة ونسبتها ومصدر توثيقها',
  ],
  'projects-finance-revenues.budgets-and-expenses': [
    'بند النفقة ونوعها والمبلغ المعتمد والمحصل والمورّد', 'السنة المالية والملاحظات',
    'التشغيلية والطارئة ومخصصات اللجان والتحويلات ودعم المشاريع',
  ],
  'projects-finance-revenues.revenues': [
    'نوع المورد والربط السنوي والمحصل فعلياً', 'الموارد المحلية والمشتركة والعامة المشتركة والدعم المركزي',
    'الإيرادات المقدرة والمحصلة والفارق ونسبة التحصيل والفترة المالية',
    'اسم المكتب أو الجهة والربط والمحصل والفارق ونسبة التحصيل',
  ],
  'development-indicators.indicator-definitions': [
    'المحور والاسم والتعريف وطريقة الحساب والمعادلة', 'البسط والمقام والوحدة والمصدر',
    'تنبيهات الجودة وحدود الاستخدام',
  ],
  'development-indicators.indicator-results': [
    'القيمة المحسوبة', 'النتائج حسب المحافظة والمديرية والجنس والفئة العمرية وتقاطعها',
    'المرجع الحضري والريفي',
  ],
  'development-indicators.targets': [
    'خط الأساس والقيمة المستهدفة وسنة الاستهداف', 'هدف المحافظة والمؤشر والهدف الوطنيان',
    'مرجعية المؤشر ومستوى المقارنة',
  ],
  'development-indicators.indicator-themes': [
    'محاور السكان والفقر والإعاقة والتعليم والأمية والصحة',
    'محاور المياه والكهرباء والطرق والصرف الصحي والاتصالات',
    'محاور الزراعة والاقتصاد والمشاريع والإيرادات والمشاركة المجتمعية',
  ],
  'development-analysis-priorities.swot': [
    'نوع تحليل SWOT ونقاط القوة والضعف والفرص والتهديدات', 'نتيجة التحليل والأدلة والأثر والمدى الزمني',
    'الأهمية وقابلية المعالجة والأولوية والاستجابة والتوصية',
  ],
  'development-analysis-priorities.pestle': [
    'الأبعاد السياسي والاقتصادي والاجتماعي والتقني والقانوني والبيئي',
    'نتيجة التحليل والأدلة والأثر والأهمية وقابلية المعالجة والأولوية والتوصية',
  ],
  'development-analysis-priorities.development-issues': [
    'رمز التجمع والتحديات القطاعية والعامة ونسبة السكان المتأثرين والهدف العام ورمز القضية',
    'البعد والقضية الرئيسية والوصف والأدلة والأسباب المباشرة والجذرية والآثار',
    'الفئات والمناطق المتأثرة والتكرار والاتساع والشدة والإلحاح وقابلية المعالجة',
    'المجموع المرجح ومستوى الأولوية ومصدر الدليل وفجوات البيانات والملاحظات',
  ],
  'development-analysis-priorities.comparisons': [
    'محور ونوع المقارنة والتجمع وقيمته ودرجته ومجموع الدرجات والترتيب والمجال',
    'البنية التحتية والتنمية البشرية والأنشطة الاقتصادية والتنمية الاجتماعية والموارد الطبيعية',
  ],
  'development-analysis-priorities.prioritization': [
    'محور الأولوية والقطاع والقضية', 'معايير التفضيل وعدم التفضيل',
    'الدرجة والمجموع المرجح والترتيب وأولوية التدخل',
  ],
  'strategic-planning.objectives-and-outcomes': [
    'الهدف التنموي العام والاستراتيجي والفرعي والقابل للقياس',
    'النتائج المستهدفة وخط الأساس والقيمة المستهدفة والسنة المستهدفة',
  ],
  'strategic-planning.programs-and-initiatives': [
    'البرنامج العام والفرعي والمبادرة والمشروع', 'الأنشطة الرئيسية والمخرج والقطاع والمحور المستهدف',
  ],
  'strategic-planning.monitoring': [
    'مؤشر الأداء والقيمة الحالية وخط الأساس والمستهدف ونسبة الإنجاز',
    'الجهة والإدارة المسؤولة والجهات المساندة ومصدر التحقق',
    'المخاطر والافتراضات وأولوية التنفيذ',
  ],
  'crosscutting-documentation-quality.identifiers-and-classifications': [
    'المعرف الفريد ورمز السجل ومعرف الكيان', 'الموقع الجغرافي والقطاع والمجال والمتغير والتصنيف',
    'الفترة ومصدر البيانات والجهة المسؤولة',
    'تصنيفات الجنس والفئة العمرية والمستوى التعليمي والمؤهل والمهنة ونوع المنشأة والنشاط والخدمة',
    'تصنيفات المورد والمنتج والأصل والملكية والحالة والموقع والمشروع والمستفيد والجهة والتصنيف الجغرافي والحضري أو الريفي',
  ],
  'crosscutting-documentation-quality.record-properties': [
    'اسم الكيان ونوعه وتصنيفه ووصفه وحالته', 'تاريخ التأسيس والبداية والنهاية والملاحظات',
  ],
  'crosscutting-documentation-quality.measurement-properties': [
    'القيمة العددية والنصية ونوع القيمة ووحدة القياس ونوع القياس',
    'العدد والإجمالي والنسبة والمتوسط والمعدل والكمية',
    'المساحة والطول والسعة والسعر وقيمة الإيراد والمصروف والسنة والفترة',
  ],
  'crosscutting-documentation-quality.source-and-provenance': [
    'معرف وثيقة المصدر واسمها والجهة المصدرة وتاريخ جمع واستلام البيانات',
    'رقم الصفحة واسم ورقة Excel ومرجع الخلية أو النطاق واسم الحقل الأصلي',
    'القيمة الخام والقيمة بعد المعالجة وطريقة التحويل وحالة التحقق ورابط المستند',
  ],
  'crosscutting-documentation-quality.data-quality': [
    'حالة الجودة والاكتمال والتحقق والمراجعة', 'سبب النقص أو الخطأ وملاحظات الجودة',
    'فحوص الاتساق والتكرار والوحدات والقيم السالبة والمفقودة وصحة العلاقات الحسابية',
  ],
  'crosscutting-documentation-quality.entry-and-approval': [
    'تاريخ الإنشاء ومدخل السجل وتاريخ آخر تحديث وآخر من حدّثه',
    'حالة الاعتماد وتاريخ الاعتماد والمراجع وملاحظات المراجعة',
  ],
  'crosscutting-documentation-quality.system-completeness': [
    'عنصر المتابعة والقيمة والحالة وتفسير الحالة', 'عدد السجلات المدخلة والمؤشرات المحسوبة والقضايا المسجلة والقضايا عالية الأولوية وعناصر التحليل',
    'اكتمال البيانات الأساسية والإجراء التالي',
  ],
  'crosscutting-documentation-quality.value-states': [
    'known: قيمة معروفة', 'zero: صفر فعلي', 'not_available: غير متوفر', 'unknown: غير معروف',
    'not_applicable: لا ينطبق', 'not_collected: لم يُجمع', 'not_verified: غير متحقق منه',
  ],
});

const HEADERS = ['requirement_id','specification_version','domain_code','domain_name','group_code','group_name','item_order',
  'requirement_item','semantic_class','coverage_state','item_match_state','item_published_field_matches','item_candidate_field_matches',
  'published_form_evidence','published_field_codes','unapproved_candidate_field_codes','evidence_limit','gap_or_decision'];
const ITEM_TYPES = Object.freeze({
  'crosscutting-documentation-quality.value-states': 'shared_capability',
  'development-indicators.indicator-results': 'measurement_or_derived_value',
  'development-indicators.indicator-definitions': 'methodology_definition',
  'projects-finance-revenues.budgets-and-expenses': 'financial_transaction',
  'projects-finance-revenues.revenues': 'financial_transaction',
});

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function normalizeArabicPhrase(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g,'')
    .replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').toLocaleLowerCase('ar')
    .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}

function findPhraseOverlaps(item, fields) {
  const normalizedItem = ` ${normalizeArabicPhrase(item)} `;
  return fields.filter(field => {
    const label = normalizeArabicPhrase(field.name);
    return label.length > 0 && normalizedItem.includes(` ${label} `);
  }).map(field => `${field.code}: ${field.name}`).sort();
}

function buildRequirementRegister(db, catalog = require('../src/main/database/manual-entry-catalog.cjs').listCatalog(db)) {
  const rows = [];
  for (const domain of catalog.domains) {
    for (const group of domain.groups) {
      const items = SPECIFICATION_ITEMS[group.code];
      if (!items) continue;
      const publishedFields = group.publishedFields.map(field => field.code).sort();
      const candidateFields = group.fields.map(field => field.code).sort();
      const formCodes = group.forms.filter(form => !form.rawCaptureOnly).map(form => form.code).sort();
      const isSharedCapability = group.code === 'crosscutting-documentation-quality.value-states';
      const evidenceState = isSharedCapability
        ? 'implemented_shared_capability'
        : publishedFields.length
          ? 'published_form_partial_group_evidence_only'
          : candidateFields.length
            ? 'unapproved_candidates_group_evidence_only'
            : 'no_current_field_mapping';
      for (const [itemIndex, item] of items.entries()) {
        const publishedMatches = findPhraseOverlaps(item,group.publishedFields);
        const candidateMatches = findPhraseOverlaps(item,group.fields);
        const itemMatchState = publishedMatches.length
          ? 'unverified_exact_label_overlap_published_field'
          : candidateMatches.length
            ? 'unverified_exact_label_overlap_candidate'
            : 'no_exact_label_overlap_found_manual_semantic_review';
        rows.push({
          id: `${group.code}.${String(itemIndex + 1).padStart(3, '0')}`,
          specificationVersion: SPECIFICATION_VERSION,
          domainCode: domain.code,
          domainName: domain.name,
          groupCode: group.code,
          groupName: group.name,
          itemOrder: itemIndex + 1,
          item,
          semanticClass: ITEM_TYPES[group.code] || 'requires_item_level_classification',
          coverageState: evidenceState,
          itemMatchState,
          itemPublishedFieldMatches: publishedMatches,
          itemCandidateFieldMatches: candidateMatches,
          publishedForms: formCodes,
          publishedFields,
          candidateFields,
          evidenceLimit: isSharedCapability
            ? 'قدرة مخطط/خدمة/واجهة مشتركة، وليست نموذجاً مستقلاً؛ التطابق النصي لا يثبت تنفيذ كل خاصية.'
            : publishedFields.length
              ? `${publishedMatches.length ? 'تطابق اسم حرفي مرشح على مستوى البند فقط؛ ' : ''}الدليل على مستوى المجموعة لا يثبت تحقق النوع والوحدة والنطاق والأبعاد أو الوظيفة.`
              : candidateFields.length
                ? `${candidateMatches.length ? 'تطابق اسم حرفي مرشح فقط؛ ' : ''}المرشحات غير معتمدة ولا تثبت تطابقاً دلالياً؛ ممنوع استخدامها للإدخال أو التحليل.`
                : 'لم يُعثر على تعريف حقل أو نموذج حالي مرتبط بهذه المجموعة.',
          gap: isSharedCapability
            ? 'اختبار سلوكي مستقل مطلوب لكل حالة عبر الحفظ والقراءة في نموذج منشور قبل وصفها بالمكتملة.'
            : publishedMatches.length
              ? 'راجع التطابق النصي مقابل التعريف والوحدة والنطاق والأبعاد والمصدر والقراءة بعد الحفظ قبل احتسابه مغطى.'
              : candidateMatches.length
                ? 'راجع المرشح دلالياً ووثق النوع والوحدة والنطاق والأبعاد والمصدر؛ لا يعتمد تشابه الاسم وحده.'
                : publishedFields.length
                  ? 'لا يوجد اسم حقل حرفي مرشح؛ افحص المرادفات المعتمدة والتعريف والمصدر قبل الحكم بعدم التغطية.'
                  : candidateFields.length
                    ? 'لا يوجد اسم مرشح حرفي؛ راجع تعريفاً موثوقاً أو وثق الحاجة إلى بنية جديدة.'
                    : 'تعريف موثوق مطلوب قبل النشر؛ لا يُستنتج المعنى أو الوحدة أو المعادلة من تشابه الاسم.',
        });
      }
    }
  }
  const expectedGroups = Object.keys(SPECIFICATION_ITEMS).sort();
  const catalogGroups = catalog.domains.flatMap(domain => domain.groups.map(group => group.code))
    .filter(code => code !== 'administrative-geography.current-directorate-compatibility').sort();
  const missingGroups = expectedGroups.filter(code => !catalogGroups.includes(code));
  const unexpectedGroups = catalogGroups.filter(code => !SPECIFICATION_ITEMS[code]);
  if (missingGroups.length) throw new Error(`مجموعات المواصفة غير موجودة في فهرس المجالات: ${missingGroups.join(', ')}`);
  if (unexpectedGroups.length) throw new Error(`مجموعات الفهرس غير الممثلة في المواصفة: ${unexpectedGroups.join(', ')}`);
  const ids = new Set(rows.map(row => row.id));
  if (ids.size !== rows.length) throw new Error('معرفات متطلبات المواصفة ليست فريدة.');
  return rows;
}

function renderCsv(rows) {
  const lines = [HEADERS.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.id, row.specificationVersion, row.domainCode, row.domainName, row.groupCode, row.groupName, row.itemOrder,
      row.item, row.semanticClass, row.coverageState, row.itemMatchState,row.itemPublishedFieldMatches.join('; '),row.itemCandidateFieldMatches.join('; '),
      row.publishedForms.join('; '), row.publishedFields.join('; '),row.candidateFields.join('; '), row.evidenceLimit, row.gap,
    ].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\n')}\n`;
}

function exportRequirementRegister(outputPath = OUTPUT_PATH) {
  const Database = require('better-sqlite3-multiple-ciphers');
  const { migrate: migrateStore } = require('../src/main/analysis/store-schema.cjs');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateStore(db);
    const rows = buildRequirementRegister(db);
    fs.writeFileSync(outputPath, renderCsv(rows), 'utf8');
    return { outputPath, rows };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const { outputPath, rows } = exportRequirementRegister();
  const groupCount = new Set(rows.map(row => row.groupCode)).size;
  process.stdout.write(`Generated ${rows.length} requirement rows in ${groupCount} specification groups from a fresh synthetic schema: ${outputPath}\n`);
}

module.exports = { HEADERS, ITEM_TYPES, OUTPUT_PATH, SPECIFICATION_VERSION, SPECIFICATION_ITEMS, buildRequirementRegister, exportRequirementRegister, renderCsv };
