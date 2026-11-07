/**
 * Renderer-side mirror of the indicator catalogue.
 *
 * The engine (main process) owns the canonical definition in `schema.cjs`. This
 * file only carries the labels the interface needs, and `tests/persist.test.cjs`
 * asserts that both lists agree so the two can never drift apart silently.
 */
export const INDICATORS_META = [
  { code: 'waterDeficit', excel: 'AN', header: 'عجز المياه %', direction: 'needUp', unit: '%' },
  { code: 'frontLineRisk', excel: 'AO', header: 'قرب النار (0/1)', direction: 'needUp', unit: '0/1' },
  { code: 'revenuePerCapita', excel: 'AP', header: 'نصيب الفرد من الإيراد', direction: 'needDown', unit: 'ريال/فرد' },
  { code: 'roadsDeficit', excel: 'AQ', header: 'عجز الطرق %', direction: 'needUp', unit: '%' },
  { code: 'populationPerFacility', excel: 'AR', header: 'سكان/منشأة', direction: 'needUp', unit: 'نسمة/منشأة' },
  { code: 'schoolsPer10k', excel: 'AS', header: 'مدارس/10 آلاف', direction: 'needDown', unit: 'مدرسة/10آلاف' },
  { code: 'agriPerCapita', excel: 'AT', header: 'إنتاج/فرد', direction: 'needDown', unit: 'طن/1000 نسمة' },
  { code: 'valueChainsScore', excel: 'AU', header: 'سلاسل قيمة (نقاط)', direction: 'needDown', unit: 'سلسلة' },
  { code: 'fiscalGap', excel: 'AV', header: 'عجز/فائض (مليار)', direction: 'needUp', unit: 'مليار ريال' },
  { code: 'associationsPer10k', excel: 'AW', header: 'جمعيات/10 آلاف', direction: 'needDown', unit: 'جمعية/10آلاف' },
  { code: 'stalledProject', excel: 'AX', header: 'تعثر (0/1)', direction: 'needUp', unit: '0/1' },
  { code: 'aidPerCapita', excel: 'AY', header: 'مساعدات/فرد كجم', direction: 'needDown', unit: 'كجم/فرد' },
];