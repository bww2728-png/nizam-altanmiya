# سجل التجهيز والبناء — نظام التنمية المحلية 0.1.0

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
4. E2E على الحزمة المثبّتة: شاشة القفل → إنشاء قاعدة → لوحة التحكم بخمسة أقسام. قاعدة البيانات مشفّرة (الترويسة ليست `SQLite format 3`).
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
عبارة المرور المستخدمة: `E2e-Prototype-2026`.

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
