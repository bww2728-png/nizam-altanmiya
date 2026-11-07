/**
 * Renderer-side mirror of the indicator catalogue.
 *
 * The engine (main process) owns the canonical definition in `schema.cjs`. This
 * file only carries the labels the interface needs, and `tests/persist.test.cjs`
 * asserts that both lists agree so the two can never drift apart silently.
 */
export const INDICATORS_META = [
  { code: 'waterDeficit', excel: 'AN', header: 'عجز المياه %', direction: 'needUp' },
  { code: 'frontLineRisk', excel: 'AO', header: 'قرب النار (0/1)', direction: 'needUp' },
  { code: 'revenuePerCapita', excel: 'AP', header: 'نصيب الفرد من الإيراد', direction: 'needDown' },
  { code: 'roadsDeficit', excel: 'AQ', header: 'عجز الطرق %', direction: 'needUp' },
  { code: 'populationPerFacility', excel: 'AR', header: 'سكان/منشأة', direction: 'needUp' },
  { code: 'schoolsPer10k', excel: 'AS', header: 'مدارس/10 آلاف', direction: 'needDown' },
  { code: 'agriPerCapita', excel: 'AT', header: 'إنتاج/فرد', direction: 'needDown' },
  { code: 'valueChainsScore', excel: 'AU', header: 'سلاسل قيمة (نقاط)', direction: 'needDown' },
  { code: 'fiscalGap', excel: 'AV', header: 'عجز/فائض (مليار)', direction: 'needUp' },
  { code: 'associationsPer10k', excel: 'AW', header: 'جمعيات/10 آلاف', direction: 'needDown' },
  { code: 'stalledProject', excel: 'AX', header: 'تعثر (0/1)', direction: 'needUp' },
  { code: 'aidPerCapita', excel: 'AY', header: 'مساعدات/فرد كجم', direction: 'needDown' },
];