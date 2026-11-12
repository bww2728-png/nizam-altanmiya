# سجل التجهيز والبناء — نظام التنمية المحلية 0.1.0

> **ملاحظة تاريخية (2026-11-12):** هذا المستند سجل بناء قديم يصف **الإصدار 0.1.0 فقط**. أُزيل تشفير SQLCipher من المنتج بقرار «التخزين غير المشفّر» (`docs/architecture/plaintext-store-decision.md`)، فالقاعدة اليوم ملف SQLite عادي بلا مفتاح. كل ذكر للتشفير أو لكلمة مرور أو لمفتاح أدناه **وصف لحالة 0.1.0 وقتها ولا ينطبق على المنتج الحالي**. عبارة المرور المذكورة لاحقًا لم تعد تُستخدم ولم تعد تحمي شيئًا؛ تُركت في مكانها لأنها جزء من السجل التاريخي، لا لأنها سرّ قائم.

> **ملاحظة:** هذا السجل يوثّق البناء الأول (0.1.0) بتاريخ 2026-11-06 بمسارات PDF/Word/OCR. أُزيلت مسارات OCR/PDF/Word بالكامل لاحقًا، وأصبح **الاستيراد من Excel هو المسار الوحيد**. راجع قسم «تحديث 2026-11-08 — الإدخال الآلي من Excel فقط» في نهاية الملف. الأقسام أعلاه محفوظة كسجل تاريخي.

المصدر: `%USERPROFILE%\Desktop\نظام الوزاره (3).zip`
مجلد العمل: `C:\dev\nizam-altanmiya`
تاريخ البناء: 2026-11-06 · Electron 45.2.3 · Node 24.18 (بناء) / 24.22 (زمن تشغيل Electron)

## ما تغيّر مقابل الحزمة الأصلية

| الملف | التغيير | السبب |
| --- | --- | --- |
| `desktop-app/package.json` | `build.win.icon = build/icon.png` | تضمين الأيقونة الجديدة في ملف التطبيق التنفيذي. |
| `desktop-app/package.json` | `signAndEditExecutable: false → true` | بدون rcedit لا تُدمج الأيقونة ولا بيانات الإصدار في الـ exe (كان سيظهر شعار Electron الافتراضي). |
| `desktop-app/package.json` | `nsis.installerIcon / uninstallerIcon / installerHeaderIcon = build/icon.ico`، `shortcutName` | أيقونة المثبّت واختصار سطح المكتب بالعربية. |
| `desktop-app/package.json` | توسيع `asarUnpack`: `@napi-rs/**`, `pdfjs-dist/**`, `tesseract.js/**`, `@tesseract.js-data/**` | ملفات تُقرأ من نظام الملفات (worker، cmaps، standard_fonts، traineddata) لا تعمل داخل asar. |
| `desktop-app/build/icon.png` + `icon.ico` | جديد | أيقونة: طير جمهوري ذهبي + درع التنمية (أعمدة صاعدة + سهم نمو + غصن بن) + شعار «الجمهورية اليمنية». |
| `tools/make-icon.cjs` | جديد | مولّد الأيقونة (@napi-rs/canvas) بجميع المقاسات 16→1024 و ICO متعدد المقاسات. |
| `desktop-app/tools/smoke.cjs` | جديد | فحص تحميل الوحدات الأصلية داخل زمن تشغيل Electron. |
| `desktop-app/tools/e2e.cjs` | جديد | فحص شامل عبر CDP للتطبيق المُحزَّم (إنشاء قاعدة مشفّرة → لوحة التحكم). |

## المخرجات

| الملف | الحجم | الوصف |
| --- | --- | --- |
| `release/Local-Development-Intelligence-0.1.0-x64.exe` | 176 MB | مثبّت NSIS (assisted، للمستخدم الحالي، اختصارات + إلغاء تثبيت). |
| `release/Local-Development-Intelligence-0.1.0-x64.zip` | 222 MB | نسخة محمولة. |
| `release/win-unpacked/` | — | نسخة غير مضغوطة للاختبار. |

نسخة التسليم للمستخدم النهائي: `%USERPROFILE%\Desktop\نظام التنمية المحلية - التثبيت\`

## نتائج التحقق

1. `npm test` → 7/7 ناجحة (قاعدة مشفّرة، مراجعة، Excel/PDF/Word، رفض الملفات غير المدعومة).
2. `npm run build` → Vite 8.3.6، 1565 وحدة، `dist/` 267 KB.
3. فحص الوحدات داخل Electron: better-sqlite3-multiple-ciphers (SQLCipher)، @napi-rs/canvas، exceljs، mammoth، pdfjs-dist (ESM)، tesseract.js + بيانات العربية — كلها تعمل.
4. E2E على الحزمة المثبّتة: شاشة القفل → إنشاء قاعدة → لوحة التحكم بخمسة أقسام. قاعدة البيانات مشفّرة (الترويسة ليست `SQLite format 3`). *(سجل تاريخي — لا ينطبق على المنتج الحالي: أُزيل التشفير بقرار التخزين غير المشفّر، والقاعدة اليوم تبدأ بترويسة `SQLite format 3\0`.)*
5. `Setup.exe /S /D=...` → تثبيت صامت ناجح؛ `Uninstall.exe /S` → إزالة نظيفة.
6. الأيقونة مدمجة في كل من `app.exe` و `Setup.exe` (تم استخراجها ومعاينتها).

## إصلاحات ما بعد المراجعة (مراجعة reviewer)

| الملف | المشكلة | الإصلاح |
| --- | --- | --- |
| `src/main/importers.cjs:138-148` | `standardFontDataUrl` و`cMapUrl` كانا يُمرَّران كـ `file://` URL، وpdf.js في Node يمرّرهما إلى `fs.readFile` → فشل تحميل CMaps يعني فشل استيراد PDF كامل (ترميزات CJK/Legacy) | استبدالها بمسار نظام عادي عبر `assetDir()` بشرطة `/` نهائية؛ إزالة `pathToFileURL` غير المستخدم. |
| `src/main/main.cjs:49-58` | `--dev-server=` كان يُحترم في النسخة المحزَّمة → أي عملية محلية تستطيع تحميل صفحة خارجية داخل النافذة مع preload كامل (تصيّد عبارة المرور) | `app.isPackaged ? null : ...` + `will-navigate` يمنع أي انتقال خارج خادم التطوير. |
| `tools/make-icon.cjs:540-548` | كان يكتب 1024 و512 في ICO بعرض/ارتفاع 256 (صيغة ICO لا تدعم >256) | مداخل ICO الآن 256/128/64/48/32/16 فقط، والـ PNG يبقى للمقاسات الكبيرة. |

تحقق إضافي: `tools/guard-check.cjs` (الحزمة المثبتة تتجاهل `--dev-server=https://example.com/` وتحمّل `resources/app.asar/dist/index.html` — PASS)، و`tools/asar-check.cjs` يشغّل داخل `app.asar` استخراج PDF وOCR عربي فعلي («التنمية المحلية» بدقة 93%) — PASS.

## إصلاح توافق ملفات Excel الحقيقية (2026-11-06، بعد اختبار ملف الوزارة)

| الملف | المشكلة | الإصلاح |
| --- | --- | --- |
| `src/main/importers.cjs` (`loadWorkbook` + `canonicalizeXmlPart`) | ملفات xlsx المولّدة بـ openpyxl (ومحوّلات أخرى) تكتب أجزاء الحزمة ببادئات أسماء مولّدة (`<ns0:Relationships>`، `<ct:Types>`، `<ns0:Properties>`، `ns0/ns2` بدل `cp/dcterms`)؛ ExcelJS يطابق أسماء الوسوم حرفيًا فيفشل الاستيراد كليًا على ملف الوزارة `نظام المديريات V3.3` بخطأ `Unexpected xml node in parseOpen` ثم `Cannot read properties of undefined (reading 'company')`. | إعادة كتابة بادئات العناصر إلى البادئة القياسية المتوقعة اعتمادًا على **URI** المساحة الاسمية (جارٍ فقط على نسخة الذاكرة عند فشل القراءة المباشرة)، ثم إعادة المحاولة. لا يُعدَّل الملف الأصلي على القرص. |
| `src/main/importers.cjs:7` | `MAX_ITEMS = 5000` كان يقتطع ملف الوزارة (40,392 قيمة في 16 ورقة) ويستورد 12% فقط. | `MAX_ITEMS = 50000`؛ الملف كامل الآن بلا اقتطاع، ورسالة الاقتطاع ما زالت تظهر لو تجاوز ملفٌ 50 ألف قيمة. |
| `tests/core.test.cjs` | لا يوجد اختبار للملفات ذات البادئات المولّدة. | اختبار جديد يبني نسخة xlsx ببادئات مولّدة، يتأكد أن ExcelJS الخام وحده يفشل عليها، ثم يتأكد أن `extractExcel` يستعيد القيم ومواقع الخلايا. |

قياس على ملف الوزارة الفعلي (Intel/Windows، Electron): استخراج 40,392 قيمة من 16 ورقة في **9.5 ثانية**، وإدخالها في قاعدة SQLCipher في **0.5 ثانية**.
اختبار دورة كاملة على الحزمة (`tools/import-e2e.cjs` يتضمن `tools/dialog-fill.ps1` لملء نوافذ الملفات الأصلية دون الاعتماد على التركيز): استيراد 40,392 → اعتماد → تصدير Excel بمحاذاة صحيحة — PASS.

## التحقق النهائي على البناء المسلَّم (2026-11-06)

البناء: `release\Local-Development-Intelligence-0.1.0-x64.exe` (07:38) و`…-x64.zip` (07:47).
تطابق `app.asar`: النسخة داخل الـ ZIP = المثبّتة = داخل `release\win-unpacked` → SHA256 `077EEF77…D791` (متطابقة تمامًا).
عبارة المرور المستخدمة: `E2e-Prototype-2026`. **ملاحظة تاريخية: هذه العبارة مهجورة ولا تحمي شيئًا اليوم**؛ المنتج الحالي لا يستخدم كلمة مرور ولا مفتاح تشفير، والقيمة مذكورة فقط لأنها جزء من سجل بناء 0.1.0.

| الفحص | النتيجة |
| --- | --- |
| `npm test` (على المصدر) | 8/8 PASS |
| `tools/asar-check.cjs` على `app.asar` المثبّتة | PASS (PDF + OCR عربي 93%) |
| `tools/guard-check.cjs` | PASS (تجاهل `--dev-server`، تحميل ملف محلي فقط) |
| `tools/e2e.cjs` على المثبّت | PASS (قفل → فتح → 5 أقسام) |
| `tools/import-e2e.cjs` على المثبّت | PASS (40,392 قيمة / 16 ورقة / بلا اقتطاع → اعتماد → تصدير) |
| `tools/import-e2e.cjs` على النسخة المحمولة | PASS (نفس النتائج) |

### ملاحظات مراجعة الكود (إصلاح `canonicalizeXmlPart`) — ليست موانع تسليم

1. إعادة التسمية تعمل على النص الخام للملف، فإن احتوى **نص خلية** حرفيًا على `<ns0:` أو `</ns0:` فسيُعاد كتابته داخل النص. الاحتمال نظري وقليل جدًا (لا يمس القيم في ملف الوزارة). الإصلاح المستقبلي: تحليل XML حقيقي (DOM/sax) بدل regex.
2. إن أعلن الجزء عن البادئة القياسية بمساحة اسم **مختلفة** عن المراد إعادة تسميتها، سيُحقن `xmlns` مكرر → خطأ تحليل. نظري فقط، ولا يقع في أجزاء OOXML الواقعية.
3. `require('jszip')` اعتماد غير مباشر (عبر `exceljs`) ويعمل داخل الحزمة (مُثبَت بالاختبار الفعلي). التوصية: إضافته إلى `dependencies` صراحة عند التحديث القادم.
4. `MAX_ITEMS = 50000` يقارن `items.length >= MAX_ITEMS` فيُبلّغ `truncated=true` حتى لو كان الملف فيه 50,000 قيمة بالضبط (تحفّظ مقبول).
5. قاعدة «صف 2 عمود 1 عنوان إن كان صف 1 فارغًا» قد تُسقط أول قيمة في ورقة عمودها الأول فارغ في الصف الأول — حالة نادرة، وملف الوزارة والتجارب لم تتأثر.

## ملاحظات تشغيلية

- التثبيت يتم للمستخدم الحالي (`perMachine: false`) → لا يحتاج صلاحيات مدير.
- الحزمة **غير موقّعة** → SmartScreen سيظهر تحذيرًا عند أول تشغيل.
- البيانات في `%APPDATA%\local-development-intelligence\development-data.db` ولا تُحذف عند إلغاء التثبيت.
- ملف `desktop-app/ara.traineddata` (2.4 MB) غير مستخدم من الكود (OCR يستخدم `@tesseract.js-data/ara`) وغير مضمّن في الحزمة.
- تقليص الحجم الممكن لاحقًا: استثناء `better-sqlite3-multiple-ciphers/prebuilds` لغير win32-x64 (~20 MB) وبعض كانات `@napi-rs` لغير Windows.

## تحديث 2026-11-08 — الإدخال الآلي من Excel فقط

إعادة توجيه النظام إلى مسار إدخال واحد: ملف Excel. أُزيلت مسارات OCR واستخراج المحتوى من PDF/Word بالكامل.

| الملف | التغيير |
| --- | --- |
| `desktop-app/src/main/ocr-pipeline.cjs`, `importers.cjs`, `repository.cjs`, `analysis/ocr-entry.cjs`, `analysis/bridge.cjs` | محذوفة. |
| `desktop-app/src/main/main.cjs` | إزالة 10 قنوات OCR/استخراج/تصدير قديمة؛ 29 قناة متطابقة 1:1 مع `preload.cjs`؛ خلفية النافذة `#0b1322`. |
| `desktop-app/package.json` | إزالة الاعتماديات: `@napi-rs/canvas`, `@tesseract.js-data/ara`, `mammoth`, `pdfjs-dist`, `tesseract.js`، و`asarUnpack` الخاص بها. بقي: `better-sqlite3-multiple-ciphers`, `exceljs`, `lucide-react`, `react`, `react-dom`. |
| `desktop-app/src/main/analysis/import-plan.cjs` | خطة استيراد: فحص → قرارات لكل صف → تطبيق في معاملة واحدة، مع حجر الصف الخطأ واستمرار البقية. |
| `desktop-app/src/renderer/` | واجهة جديدة بالكامل (7 شاشات: اللوحة، المؤشرات الـ 12، ترتيب الأولويات، الاستيراد الآلي، تصحيح البيانات، قاعدة البيانات الشاملة، بطاقة مديرية) بتصميم داكن كحلي/ذهبي وحركات ظهور واختفاء. |
| `desktop-app/src/main/analysis/pdf.cjs`, `exporter.cjs` | مخرجات رسمية: لا تذكر ملف الإدخال، تعرض مساري القياس (المؤشر المرجّح + مؤشر الاحتياج المعاير) وفروقهما، وتوثّق المنهجية (k=4/12، خط الحرمان 0.6) وحدود التقرير. Excel: 7 أوراق (قاعدة البيانات، الترتيب، الفجوات، استقرار الترتيب، المنهجية والأوزان، بيانات الإصدار، سجل التدقيق). |
| `desktop-app/scripts/e2e-analysis.cjs` | إعادة كتابة كاملة على 20 مديرية: 37 فحصًا للدخول والاستيراد والشاشات ووضع الوصول والتصدير، مع تقرير عيوب مصنّف وتقرير تجربة استخدام. النتيجة: 37/37. |

التحقق: `node --test tests/*.test.cjs` → 77/77 ناجحة؛ `npx vite build` ناجح؛ `npx electron scripts/e2e-analysis.cjs` → 37/37.

## تحديث 2026-11-08 — الدمج على main وتصليب الجولة الرابعة

دُمج الفرع `feature/excel-import-v1` في `main` بدمج غير سريع، ثم حُذف الأصل اليتيم وحُلّت عيوب مراجعة ما بعد الدمج.

| الالتزام | المحتوى |
| --- | --- |
| `fdd67e7` | الإدخال الآلي من Excel فقط + الواجهة الداكنة + التقارير الرسمية. |
| `1a96339` | إغلاق تسريبات وضع `shared` (إعادة الاشتقاق عبر `analyzeShared`، فلترة `import_warnings`، تصفير المشتقات) + توحيد «الحرمان الحاد يتصدّر» + تقسيم تام في `buildRanking`. |
| `33e91ec` | حذف `desktop-app/ara.traineddata` اليتيم (2.4MB، بلا مستهلك بعد إزالة OCR). |
| `0a136c9` | دمج الفرع في `main` بلا تعارضات. |
| `8a4c977` | تصليب الجولة الرابعة (أدناه). |

التصليب في `8a4c977`:

- `engine.cjs`: `fragileCount`/`sampleSensitivityTruncated` تُعيد `null` عند تخطّي الحساسية (كانت `0` مضلّلة)؛ `summary` يضم `governorates` مطابقًا لقاعدة لوحة المعلومات.
- مسند واحد مشترك `isRankableCalibrated` تستخدمه ورقة Excel وPDF والتصدير فلا تتباعد.
- `sheets.cjs`: `meta` يحاذي الدلاء المرئية فلا تختلف «مؤهلة» عن «مرشحون في آخر تشغيل»؛ بطاقة «الحرمان الحاد» في PDF من نفس المجموعة المرتّبة.
- `persist.cjs`: الحفظ اليدوي يمسح تحذير الاستيراد فقط للمفاتيح التي تغيّرت قيمتها فعلًا (كان يمحو كل التحذيرات بعد أي تعديل خلية).
- `gaps.cjs`: أكواد السجلات المتقاطعة (مثل `duplicate-district`) تُدخل `byCode`.
- `security.cjs`/`main.cjs`: `maskEngineRow` يُصفّر المشتقات ويُرشّح التحذيرات؛ حمولات الأوراق تُجرَّد عبر `maskInputRows`.
- `import-plan.cjs`: إزالة الأكواد الميتة `invalid-text`/`invalid-ratio`.

التحقق: `node --test tests/*.test.cjs` → **120 (119 نجاح، 1 متخطّى)**؛ `npx vite build` ناجح؛ `npx electron scripts/e2e-analysis.cjs` → **37/37**.

## تثبيت 0.5.0 على الجهاز (2026-11-08)

| البند | القيمة |
| --- | --- |
| المثبّت | `desktop-app/release/Local-Development-Intelligence-0.5.0-x64.exe` (139.5 MB) |
| النسخة قبل | 0.3.0 |
| النسخة بعد | 0.5.0 (`ProductVersion=0.5.0.0`، FileVersion `0.5.0`) |
| مسار التثبيت | `%LOCALAPPDATA%\Programs\local-development-intelligence` |
| `app.asar` المثبّت | 63 MB بتاريخ البناء |

- تعذّر تنزيل Electron عبر الشبكة (`read ECONNRESET`) رغم وجود الـzip في الكاش، فبُني المثبّت باستخدام `build.electronDist` مؤقتًا يشير إلى الـzip المحلي في كاش electron-builder، ثم أُعيد `package.json` إلى حالته الملتزمة.
- التثبيت تم بصمت (`/S`) فوق 0.3.0، وبيانات المستخدم في `%APPDATA%\local-development-intelligence\development-data.db` لم تُمَس.
- اختبار إقلاع: التطبيق المثبّت انطلق بنجاح (4 عمليات Electron) ثم أُغلق.

## المستودع العام والتحديث الذاتي (2026-11-08)

المستودع: `https://github.com/bww2728-png/nizam-altanmiya` (عام، الفرع الافتراضي `main`).

### محتوى المستودع

- **مُستبعَد** (يبقى محليًا فقط، مضاف إلى `.gitignore`): قوالب `*.xlsx` المرجعية في الجذر، مجلدا `تدقيق-شامل/` و`نتائج-الفحص/` (صور/مخرجات الفحص)، لقطات الشاشة، وملفات نتائج الفحص (`*-result.json`, `*-stdout.txt`, `*-log.txt`). أُزيل تتبّع 55 ملفًا قائمًا عبر `git rm --cached` دون حذفها من القرص.
- **مُبقى للاختبار**: `desktop-app/tests/fixtures/template-v3.3.xlsx` (استثناء صريح من قاعدة `*.xlsx`).
- **أُدرج للبناء**: `desktop-app/build/icon.png` و`icon.ico` (كان مجلد `build/` متجاهَلًا ويحتاجه electron-builder) عبر `!desktop-app/build/`.

### التحديث الذاتي

| العنصر | التفصيل |
| --- | --- |
| المحرّك | `electron-updater@6.8.11` (تبعيته في `dependencies`). |
| المصدر | `build.publish` → مزوّد `github` للمالك `bww2728-png` والمستودع `nizam-altanmiya`، مع `releaseType: "release"` (المحدّث يتجاهل المسودات). |
| في التطبيق | `desktop-app/src/main/main.cjs`: يفحص `autoUpdater` عند الإقلاع بعد 8 ثوانٍ ثم كل 6 ساعات، ويحمل التحديث تلقائيًا ويثبّته عند الخروج، مع اقتصار التشغيل على إصدار Windows المثبّت. عند أي فشل تُعاد المحاولة تلقائيًا بلا عدّاد محاولات: كل 15 دقيقة لفشل الفحص، وكل 60 دقيقة لفشل التنزيل، وتُلغى عند أول نجاح. |
| الشبكة | الحرّاس الشبكية مبقاة بقرار المالك (2026-11-10): `offline-policy.cjs` يسمح فقط بنطاق التحديث الرسمي (`releases.atom`, `releases/latest`, `releases/tag/<ver>`, `releases/download/<ver>/<file>` و`objects/release-assets.githubusercontent.com`) وبمنافذ RAGFlow المحلية (`127.0.0.1:9380`) لخدمة الذكاء الوثائقي، ويمنع ما عداها. |
| النقل | `autoUpdater.disableDifferentialDownload = true` (2026-11-10): موفّر GitHub يعطّل الطلبات المتعددة (`GitHubProvider.js:16`) فيطلب التنزيل التفاضلي كل كتلة بطلب مدى منفصل (`DifferentialDownloader.js:182`)؛ على وصلة زمن أول بايت فيها ~7 ثوانٍ يتوقف النقل عمليًا. البث الواحد المتصل يتقدّم دائمًا. |
| الجسر | `desktop-app/src/main/preload.cjs`: `updateStatus`, `checkForUpdates`, `installUpdate`, `onUpdateStatus`. |
| الواجهة | `desktop-app/src/renderer/App.jsx`: مكوّن `UpdateBanner` يعرض التوفر والتنزيل والاكتمال والخطأ. |
| CI | `.github/workflows/release.yml` على **كل دفع إلى `main`** (windows-latest): `npm ci` → `npm test` (بوابة) → `scripts/ci-version.cjs` (إصدار تلقائي) → بناء → نشر إصدار GitHub واحد بأصول المثبّت و`blockmap` و`latest.yml`. |

### الإصدارات والتحقق

| الوسم | الالتزام | النتيجة |
| --- | --- | --- |
| `v0.5.1` | `15766ce` | سير العمل نجح؛ إصدار منشور واحد بثلاثة أصول (`exe` + `blockmap` + `latest.yml`). |
| `v0.5.2` | `6610d3c` | سير العمل نجح؛ إصدار منشور واحد بثلاثة أصول. |

اختبار الحلقة الكاملة:

1. ثُبّت `0.5.1` محليًا (بُني باستخدام `build.electronDist` المؤقت ثم أُعيد `package.json`)، `ProductVersion=0.5.1.0`، و`resources/app-update.yml` يشير إلى المستودع الصحيح.
2. عند الإقلاع اكتشف المحدّث `0.5.2`؛ جرّب تنزيلًا تفاضليًا فكشف عدم تطابق `sha512` في الكاش القديم، فتراجع تلقائيًا إلى تنزيل كامل — سلوك مقصود.
3. سجل التطبيق: `New version 0.5.2 has been downloaded to ...\local-development-intelligence-updater\pending\Local-Development-Intelligence-0.5.2-x64.exe` (133.32MB).
4. عند إغلاق النافذة (`autoInstallOnAppQuit`) ثُبّت التحديث تلقائيًا → `ProductVersion=0.5.2.0`.
5. اختبار إقلاع 0.5.2: 4 عمليات Electron بلا أخطاء.

### طريقة إصدار تحديث

1. التزم أي تغيير وادفعه إلى `main`.
2. يشغّل ذلك سير العمل `Release` تلقائيًا: يفحص الاختبارات، يشتق إصدارًا أعلى (`major.minor.<GITHUB_RUN_NUMBER>`) عبر `desktop-app/scripts/ci-version.cjs`، يبني المثبّت، وينشره إصدارًا عامًا.
3. التطبيق المثبّت يكتشف الإصدار الأعلى خلال 8 ثوانٍ من الإقلاع (ثم كل 6 ساعات)، ينزّله، ويثبّته عند الإغلاق.
4. لا حاجة إلى رفع رقم الإصدار يدويًا ولا إلى وسم يدوي: `GITHUB_RUN_NUMBER` يتزايد دائمًا، و`patch` لا يتراجع.

لا قيود شبكية على التطبيق بعد إزالة الحراسة؛ تبقى قاعدة البيانات والتحليلات محلية، ولا يرسل التطبيق بياناته إلى أي جهة.

### ملاحظات

- الحزمة **غير موقّعة**؛ SmartScreen قد يعرض تحذيرًا. التحديث التلقائي يعمل دون توقيع، وجذر الثقة هو حساب GitHub نفسه.
- «أي تغيير» يعني أي دفع إلى `main`: يُبنى إصدار من كل دفع (لا يعتمد على وسم يدوي).
- كاش المحدّث: `%LOCALAPPDATA%\local-development-intelligence-updater`.

## تحديث 2026-11-08 — التحديث التلقائي على كل دفع، وإلغاء سياسة الحراسة

القرار (بناءً على طلب المالك): أي تغيير في المستودع يجب أن يصل تلقائيًا إلى البرنامج المثبّت، مع إلغاء حرّاس الشبكة بالكامل. أُعيد البناء فوق `main` المدموج (`c4aa903`, PR #3) للحفاظ على ميزة التقارير المفلترة.

| الملف | التغيير |
| --- | --- |
| `desktop-app/src/main/offline-policy.cjs` | محذوف. |
| `desktop-app/tests/offline-policy.test.cjs` | محذوف. |
| `desktop-app/src/main/main.cjs` | إزالة الاستيراد والحرّاس (`installOfflineNetworkGuards`/`installOfflineSessionGuard`) وإزالة `net`/`session` من استيراد Electron؛ إعادة `updateStatus` إلى الحالة المحلية؛ تحصين المحدّث (رتابة `downloaded`، تنظيف المؤقتات، `disableWebInstaller`، `allowDowngrade=false`). |
| `desktop-app/scripts/e2e-analysis.cjs` | إزالة فحص الشبكة وتتبّع `offline-policy`. |
| `desktop-app/tests/interaction-harness.test.cjs` | إزالة فحص الحرّاس؛ تحديث فحص سير العمل للإصدار التلقائي. |
| `desktop-app/tests/auto-update.test.cjs` | جديد: يثبّت ربط المحدّث والقنوات ونشر GitHub وتزايد الإصدار. |
| `desktop-app/scripts/ci-version.cjs` | جديد: يشتق `major.minor.<GITHUB_RUN_NUMBER>` ويضمن ألا يتراجع `patch`. |
| `.github/workflows/release.yml` | إعادة كتابة: كل دفع إلى `main`، بوابة `npm test`، إصدار تلقائي، بناء NSIS، نشر إصدار عام. |
| `desktop-app/package.json` / `package-lock.json` | الأساس `0.6.0`. |

التحقق المحلي: `node --test` → 170 (169 نجاح، 1 متخطّى، 0 فشل)؛ `npx vite build` ناجح؛ `npx electron scripts/e2e-analysis.cjs` → 50/50.

## تحديث 2026-11-10 — تشخيص عدم وصول التحديثات وإصلاح النقل

المشكلة: النسخة المثبّتة 0.6.10 لم تصلها الإصدارات 0.6.11 و0.6.12 رغم نشرها.

الأدلة المقيسة على الجهاز:

1. القناة سليمة: المحدّث في 0.6.10 اكتشف 0.6.12 وأنشأ `pending\temp-Local-Development-Intelligence-0.6.12-x64.exe`، و`latest.yml` يعلن الإصدار 0.6.12 بحجم 139,991,314 وبصمة `sha512` معلنة.
2. الحرّاس ليست السبب: `offline-policy.cjs` على `main` يسمح بإعادة التوجيه إلى `/releases/tag/<ver>` (PR #7)، وقد نجحت مرحلة الكشف.
3. السبب الفعلي هو التنزيل التفاضلي: موفّر GitHub يعطّل `isUseMultipleRangeRequest` (`GitHubProvider.js:16`)، فيصدر `DifferentialDownloader` طلب مدى منفصلًا لكل كتلة (`DifferentialDownloader.js:182`). زمن أول بايت من CDN جيت هاب من هذه الشبكة ~7 ثوانٍ والإنتاجية المتصلة ~60KB/s، فتوقف النقل عند 0 بايت لدقائق ثم تقدّم إلى 26MB ثم 61MB.
4. لا استكمال بين التشغيلات: `DownloadedUpdateHelper.createTempUpdateFile` يحذف الملف المؤقت قبل كل محاولة، فإغلاق التطبيق يلغي التقدّم.

| الملف | التغيير |
| --- | --- |
| `desktop-app/src/main/main.cjs` | `autoUpdater.disableDifferentialDownload = true` (بث واحد متصل بدل طلبات المدى)؛ إعادة محاولة تلقائية بلا عدّاد محاولات: كل 15 دقيقة لفشل الفحص وكل 60 دقيقة لفشل النقل أو التثبيت، تُلغى عند أول نجاح وتُعطَّل عند الإغلاق (`updateStopped`). فشل التثبيت بعد `downloaded` يُسقط الحالة اللاصقة قبل نشر الخطأ، فلا يبقى زر إعادة تشغيل لا يعمل ولا تتعطّل الفحوص اللاحقة. |
| `desktop-app/package.json` | `build.compression = "maximum"` لتقليل حجم المثبّت المنشور. |
| `desktop-app/tests/auto-update.test.cjs` | يثبّت الخيارين وإعادة المحاولة التلقائية وغياب العدّاد. |
| `BUILD-INFO.md` | تحديث جدول التحديث الذاتي وصيانة وصف الشبكة بعد إعادة الحرّاس. |

ملاحظة تشغيلية: حجم المثبّت ~140MB، فعلى وصلة ~60KB/s يحتاج التنزيل المتصل نحو 40 دقيقة من بقاء التطبيق مفتوحًا، وإغلاق التطبيق أثناء التنزيل يلغي التقدّم ويعيده من الصفر.
