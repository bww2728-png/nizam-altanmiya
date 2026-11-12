# قرار التخزين غير المشفّر: قاعدة SQLite عادية

**الحالة:** منفّذ في الفرع `feat/plaintext-store`.
**تاريخ القرار:** 2026-11-12.
**النطاق:** `desktop-app/src/main/store.cjs`، `desktop-app/src/main/main.cjs`، `.gitignore`، وسكربت الدليل `desktop-app/scripts/e2e-analysis.cjs`.
**غير مشمول:** مخطط قاعدة البيانات والجداول والأعمدة والترحيلات — لم يتغيّر أي منها (انظر «ما لم يتغيّر» في آخر المستند).

## القرار

أُزيل تشفير SQLCipher من المنتج. مخزن النظام الآن ملف SQLite عادي يُفتح بلا مفتاح بأي أداة SQLite، وتُقرأ نسخه الاحتياطية بالطريقة نفسها. سبب القرار: التخلّص من خطر فقدان المفتاح الذي يجعل البيانات غير قابلة للاسترجاع، والسماح بفحص القاعدة بأدوات قياسية عند الحاجة التشغيلية.

هذا قرار مقايضة صريح، لا ادعاء أمان: الحماية صارت من مسؤولية حساب نظام التشغيل وصلاحيات الملفات والأمان المادي، لا من مسؤولية شيفرة. ولا يستطيع هذا المستند ولا المنتج أن يَعِد بحماية لا وجود لها.

## ما أُزيل وما بقي

**أُزيل:**

- توليد مفتاح جديد لأي قاعدة بيانات: `loadOrCreateStoreKey()` (`store.cjs:99`) لا يكتب شيئًا ويعيد `null` عند غياب المفتاح.
- اشتراط المفتاح لفتح القاعدة أو لأخذ نسخة احتياطية دورية: `openStore()` (`store.cjs:658`) يُفتح بلا مفتاح، و`backupPlaintextStore()` (`store.cjs:332`) ينسخ القاعدة والملفات الجانبية ولا ينسخ مفتاحًا ولا يطلبه، و`createConsistentBackup()` (`main.cjs:857`) يرفض النسخة التي لا تُصنَّف `plaintext` ويحذفها (`main.cjs:872-878`).
- حجر الملفات غير المعروفة عند الفتح: قناة `db:open` (`main.cjs:787`) لم تعد تستدعي `quarantineLegacyDatabase()` ولا تنشئ نسخة قبل الحجر. الدالة نفسها ما زالت مصدَّرة من الوحدة (`store.cjs:1398`) وتختبرها `tests/persist.test.cjs`، لكن مسار الإنتاج لا يصل إليها.

**بقي (مسار قديم للقراءة فقط):**

- `openEncryptedStore()` (`store.cjs:590`) و`backupStore()` (`store.cjs:270`) و`restoreBackupBundle()` (`store.cjs:399`) و`copyStoreKey()` (`store.cjs:130`) و`readStoreKey()` (`store.cjs:73`): تُستخدم لتصنيف قاعدة مشفّرة وتحويلها، وللتحقق من حزمة احتياطية مشفّرة قديمة واستعادتها بمفتاحها.
- الاعتمادية `better-sqlite3-multiple-ciphers` تبقى ضرورة لهذا المسار القديم: لا بد أن تظل الملفات المشفّرة القديمة قابلة للفتح والتحقق والاستعادة.
- `store.key` مادة قديمة للقراءة فقط. وجوده لا يحمي شيئًا؛ قيمته الوحيدة أنه يفتح قاعدة مشفّرة قديمة. ملف مفتاح تالف أو ناقص يُرفض برسالة صريحة ولا يُعاد توليده (`store.cjs:79`، `store.cjs:113-120`).

## آلية التحويل عند أول فتح

نقطة الدخول الوحيدة للإنتاج هي `openDatabase()` (`main.cjs:210`) وتستدعي `openOrConvertStore(getDatabasePath(), { keyPath: getStoreKeyPath() })` (`store.cjs:1317`).

1. **تفريق الحالة.** إن غاب الملف أو كان فارغًا تُنشأ قاعدة عادية جديدة بلا مفتاح (`store.cjs:1337-1344`). وإلا يُقرأ `store.key` إن وُجد ويُستدعى `classifyStore(path, key)` (`store.cjs:761`) الذي يجرّب القراءة العادية أولًا ثم القراءة بالمفتاح.
2. **قاعدة عادية أصلًا** (`reason === 'plaintext'`): تُفتح عبر `openStore()` ولا يُلمس أي مفتاح (`store.cjs:1348`).
3. **قاعدة مشفّرة يمكن فتحها بالمفتاح** (`reason === 'readable'`): يُستدعى `convertEncryptedStoreInPlace()` (`store.cjs:1108`).
4. **ما عدا ذلك:** رسالة عربية صريحة: قاعدة مشغولة في نافذة أخرى (`store.cjs:1352`)، أو تالفة (`store.cjs:1355`)، أو مشفّرة بلا مفتاح متاح (`store.cjs:1358`)، أو المفتاح الموجود لا يفتحها (`store.cjs:1362`). لا يُعدَّل أي ملف في هذه الحالات.

### تصحيح: كيف يفكّ التحويل التشفير فعليًا

نسخة سابقة من هذا المستند ادّعت أن `database.serialize()` هو السبيل الوحيد المتاح، وأن «لا بديل محدود الذاكرة في هذا المحرك». الشقّ الثاني خطأ ويُصحَّح هنا، والشيفرة الحالية لا تستخدم `serialize()` إطلاقًا.

الآلية المنفّذة في `exportStoreAsPlaintext()` (`store.cjs:1004`):

1. يُتحقق من القاعدة المشفّرة المصدر بالفحص القوي المشترك (`store.cjs:1025`) قبل أي نسخ.
2. `fs.copyFileSync(source, outputPath, COPYFILE_EXCL)` يجعل نظام التشغيل ينسخ الملف بثًّا بذاكرة ثابتة، مع الملفات الجانبية `-journal`/`-wal`/`-shm` (`store.cjs:1028-1035`).
3. تُفتح النسخة بـ `PRAGMA cipher = 'sqlcipher'` ثم `PRAGMA key = '<hex>'`، ويُقرأ عدد كائنات `sqlite_master` للتأكد من عمل الشيفرة (`store.cjs:1037-1042`).
4. إن وُجد `-wal` تُدمج بـ `wal_checkpoint(TRUNCATE)` ثم `journal_mode = DELETE` (`store.cjs:1043-1049`).
5. **فك التشفير** بـ `PRAGMA rekey = ''` (`store.cjs:1050`) — وهو الشكل الموثّق لدى المحرك نفسه: `desktop-app/node_modules/better-sqlite3-multiple-ciphers/README.md:105` («A database can be encrypted and decrypted simply using `key` and `rekey` `PRAGMA` statements»)، وتنصّ طبقة SQLCipher المضمّنة على أن `pNew==0 or nNew==0` تعني فك التشفير (`.../deps/sqlite3/sqlite3.h:14457`). ما يقع فعليًا ليس إعادة كتابة للصفحات في الملف نفسه داخل تدفّق واحد:
   - المفتاح الجديد فارغ، فيُسلَك فرع فك التشفير (`zKey == NULL || nKey == 0`) ويُسقَط مفتاح الكتابة (`sqlite3mcSetHasWriteCipher(codec, 0)`) — `.../deps/sqlite3/sqlite3.c:339695-339699`.
   - قاعدة SQLCipher تحمل دائمًا منطقة محجوزة غير صفرية في كل صفحة (`nReserved > 0`)، فلا تكفي إعادة كتابة الصفحات في المعاملة نفسها، بل يُستدعى `sqlite3mcRunVacuumForRekey()` (`sqlite3.c:339700-339707`، التعريف `sqlite3.c:338945-339234`).
   - تلك الدالة VACUUM معدَّل لتصفير المنطقة المحجوزة: تُلحق قاعدة مؤقتة باسم عشوائي (`sqlite3.c:339024-339027`)، وتُنشئ المخطط وتنسخ كل جدول داخلها في معاملة واحدة (`sqlite3.c:339076-339128`)، ثم تعيد صفحات الملف الأساسي من النسخة المؤقتة عبر `sqlite3BtreeCopyFile(pMain, pTemp)` (`sqlite3.c:339186-339188`)، ثم تُفصل القاعدة المؤقتة فتُحذف مع ملفاتها الجانبية (`sqlite3.c:339214-339231`).
   - الحصيلة: إعادة بناء كاملة عبر قاعدة مؤقتة على القرص ثم نسخ الصفحات إلى الملف الأصلي. الذاكرة تبقى محدودة بكاش الصفحات (افتراضيًا ~2 MB في هذا المحرك) ولا تنمو مع حجم الملف، لكن العمل يستهلك مساحة قرص عابرة (أدناه).
6. تُحذف الملفات الجانبية للنسخة فورًا (`store.cjs:1056`)، ثم تتحقق النسخة بالفحص القوي مع `requirePlaintext: true`؛ أي فشل يحذف الناتج ويُعلم أن القاعدة الأصلية لم تُعدّل (`store.cjs:1063-1073`).

البدائل التي جُرّبت على نسخة من ملف مشفّر (سكربت تجربة محلي خارج الشجرة): `PRAGMA rekey = ''` ينجح، و`db.rekey(Buffer.alloc(0))` ينجح، أما `db.rekey('')` فيفشل برسالة `Expected the key to be a Buffer`؛ لأن واجهة `rekey()` في هذا المحرك تستقبل `Buffer` لا نصًا.

**قياس على المخزن الحقيقي (152,678,400 بايت)، مرة واحدة عند تغيير الآلية، بسكربت مقارنة محلي خارج الشجرة:**

| المقياس | `serialize()` (السابق) | نسخة + `PRAGMA rekey = ''` (الحالي) |
|---|---|---|
| ذروة الزيادة في RSS | 172.8 MB | 2.07 MB |
| زمن التنفيذ | 2,432 ms | 6,699 ms |

التكلفة الزمنية تحدث مرة واحدة عند أول فتح (التحويل يقع مرة واحدة فقط)، بينما الزيادة في الذاكرة تُقاس على القاعدة كاملة، وهو ما كان قيدًا حقيقيًا على المخازن الكبيرة. عمود `serialize()` لا يمكن إعادة قياسه من الشجرة الحالية لأن الشيفرة استُبدلت؛ الرقمان أعلاه **قياس واحد** موثّق وقت التغيير على مخزن حجمه 152,678,400 بايت، لا قياس متكرر؛ أما آلية `rekey` نفسها فقابلة للتحقق بأي وقت (انظر قسم التحقق).

**التكلفة التخزينية العابرة (حساب من الملفات التي ينشئها المسار، لا قياس مقيس):** في لحظة الذروة توجد في مجلد البيانات أربع نسخ بالحجم نفسه: القاعدة المشفّرة الحيّة، ونسختها داخل `backups\` (`backupStore`، `store.cjs:1109`)، والنسخة العادية المرحلية `<store>.plaintext-<الطابع>.db` (`store.cjs:1016`)، والحزمة المشفّرة المحفوظة `<store>.encrypted-<الطابع>.bak` (`store.cjs:1135`) — أي نحو 4× حجم القاعدة، وتبقى 3× بعد التحويل (الحزمة والنسخة في `backups`، مع تقليم الحزم لاحقًا). ويُضاف قرابة 1× إضافي في مجلد الملفات المؤقتة للنظام (temp، وهو موقع القاعدة المؤقتة افتراضيًا) ما دام `PRAGMA rekey = ''` جاريًا (ملف VACUUM المؤقت). على مخزن 152,678,400 بايت يعني ذلك قرابة 611 MB في مجلد البيانات في الذروة (~458 MB بعده) وحوالي 153 MB مؤقتة. لذلك يجب التحقق من المساحة الحرة قبل أول تشغيل لإصدار يقرأ قاعدة مشفّرة، ولا يُستخدم هذا المسار على قرص ضيق.

## الفحص القوي المشترك `verifyStoreIdentity`

`verifyStoreIdentity(filePath, key, expected, options)` (`store.cjs:895`) هو الفحص الوحيد المعتمد عند كل نسخ أو تبديل، ويرفض أي نسخة لا تحقّق كامل ما يلي:

- عند `requirePlaintext`: ترويسة الملف هي `SQLite format 3\0` بالضبط (`store.cjs:897-902`).
- `integrity_check` نتيجته `ok` (`inspectStore`، `store.cjs:828-838`).
- `foreign_key_check` لا يعيد صفوفًا (`store.cjs:911-929`).
- الملف يحمل جداول النظام `import_batches` و`directorates` (`assertStoreTables`، `store.cjs:854`)، وإلا فهو ليس قاعدة هذا التطبيق.
- قائمة الجداول مطابقة، وعدد صفوف كل جدول مطابق، ومجموعة نصوص SQL مرتبة مأخوذة من `sqlite_master` مطابقة (`assertSameIdentity`، `store.cjs:866`؛ `sqliteMasterTexts`، `store.cjs:811`). تشابه أعداد الصفوف وحده لا يكفي للمرور.

مواضع تطبيقه:

| الموضع | المرجع |
|---|---|
| القاعدة المشفّرة المصدر قبل التصدير | `store.cjs:1025` |
| النسخة العادية المرحلية بعد فك التشفير وقبل التبديل | `store.cjs:1065` |
| القاعدة المثبَّتة بعد التحويل وقبل حذف العلامة | `store.cjs:1154` |
| النسخة المرحلية قبل التبديل في الاستعادة العادية | `store.cjs:558` |
| القاعدة المثبَّتة بعد الاستعادة العادية | `store.cjs:572` |
| النسخة المرحلية قبل التبديل في الحزمة المشفّرة القديمة | `store.cjs:463` |
| القاعدة المثبَّتة بعد استعادة الحزمة المشفّرة | `store.cjs:475` |

## السلامة عند الانهيار والاستعادة

التبديل لا يستخدم معاملة على نظام الملفات، فغلافه ملف علامة:

- `writeConversionMarker()` يكتب `<store>.plaintext-conversion.json` بعلم `'wx'` (أي أن وجود علامة سابقة خطأ لا يُكتب فوقه) وقبل لمس أي ملف (`store.cjs:947-951`، `store.cjs:1118-1129`).
- محتوى العلامة: مسار النسخة المرحلية `stagingPath`، ومسار النسخة المشفّرة المحفوظة `keptEncryptedPath`، ومسار المفتاح `keyPath`، ومسار الهدف `targetPath`، ووقت الإنشاء `createdAt`، وبصمة متوقعة `expected` تحمل قائمة الجداول وعدد صفوف كل جدول والإجمالي.
- الأصل يُنسخ ولا يُنقل: `fs.copyFileSync` إلى `<store>.encrypted-<طابع زمني>.bak` مع ملفاته الجانبية ومفتاحه (`store.cjs:1135-1142`)، فيبقى المسار الحيّ يحمل قاعدة سليمة أطول مدة ممكنة.
- ثم يُحذف الملف الحيّ (`store.cjs:1144`) وتُنقل النسخة المرحلية المتحقَّق منها العملية `renameSync` واحدة إلى مكانه (`store.cjs:1146`)، ثم يُحذف ملف العلامة بعد نجاح الفحص على القاعدة المثبَّتة (`store.cjs:1154-1160`).
- أي فشل بعد وجود العلامة يُزيل النسخة العادية نصف المثبَّتة، ويعيد الملف المشفّر إلى المسار الحيّ، ويحذف نسخة المفتاح المرافقة، ويُبلغ بصدق هل تمّت الإعادة أم لا (`store.cjs:1164-1194`).

**عند بدء التشغيل** يقرأ `openOrConvertStore` العلامة ويستدعي `recoverInterruptedConversion()` (`store.cjs:1217`) الذي يعالج أربع حالات، ولا ينشئ قاعدة فارغة أبدًا ما دامت العلامة تشير إلى بيانات قابلة للاسترجاع:

| الحالة | السلوك | `recoveredFrom` |
|---|---|---|
| (أ) القاعدة الحيّة سليمة (`classifyStore().ok`) | تُحذف العلامة والنسخة المرحلية الباقية، ثم فتح عادي | `null` (`store.cjs:1241-1248`) |
| (ب) القاعدة الحيّة غائبة + نسخة مرحلية صالحة | يُكمل التبديل بنقل النسخة المرحلية إلى مسار القاعدة وتُحذف العلامة | `'plaintext-staging'` (`store.cjs:1253-1274`) |
| (ج) القاعدة الحيّة غائبة ولا نسخة مرحلية صالحة + نسخة مشفّرة محفوظة بمفتاحها | تُعاد النسخة المشفّرة إلى المسار الحيّ وتُحذف علامة التحويل، ثم يُعاد التحويل مرة واحدة عبر المسار العادي | `'encrypted-backup'` (`store.cjs:1280-1299`) |
| (د) أي شيء آخر | خطأ عربي صريح يسمّي كل المسارات ويعدّد خيارات المعالجة، ولا يُنشئ قاعدة | يرمي استثناءً (`store.cjs:1225-1236`، `store.cjs:1302`) |

علامة موجودة لكن غير مقروءة أو ناقصة الحقول هي نفسها حالة رفض صريح (`readConversionMarker`، `store.cjs:958-976`)، لا إعادة تهيئة صامتة.

**تنظيف المخلفات:** `pruneConversionLeftovers()` (`store.cjs:217`) يُنفَّذ في بدء التشغيل (`store.cjs:1334`) ويحذف `<store>.plaintext-*` و`<store>.restore-*` و`<store>.rollback-*` (وكذلك الأنماط نفسها لمسار ملف المفتاح)، ولا يلمس شيئًا تشير إليه علامة تحويل حيّة. ملاحظة دقيقة: وجود مخلفات بلا علامة تحويل يجعلها تُقلَّم ثم تُبنى قاعدة جديدة، لأن العلامة هي مصدر الحقيقة الوحيد للاسترجاع.

## النسخ الاحتياطية والاحتفاظ

- **الحزم المشفّرة المحفوظة بجوار القاعدة:** `pruneEncryptedOriginals()` (`store.cjs:175`) يُبقي أحدث حزمتين فقط من `<store>.encrypted-*.bak` (الحد `KEPT_ENCRYPTED_BACKUPS = 2` في `store.cjs:17`)، ويعمل عند نهاية كل تحويل (`store.cjs:1161`) وعند كل بدء تشغيل (`store.cjs:1335`). الحزمة وحدة واحدة: تُحذف مع `.key` ومع الملفات الجانبية `-journal`/`-wal`/`-shm`، وأحدث حزمة لا تُحذف أبدًا (`store.cjs:186-203`)، وكل مسار محذوف يُسجَّل في السجل (`store.cjs:200`). `store.key` نفسه لا يطابق أي من أنماط الحذف أعلاه؛ يُستبدل فقط عند استعادة حزمة مشفّرة قديمة بمفتاحها (`restoreBackupBundle`، `main.cjs:920`).
- **مجلد `backups\`:** تُقلَّم الحزم إلى أحدث 10 افتراضيًا (`pruneBackups` عبر `backupStore` و`backupPlaintextStore`، `store.cjs:146`، `store.cjs:280`، `store.cjs:334`).
- **منع التسريب عبر Git:** `.gitignore:40-42` يستثني `*.bak` و`*.bak.key` و`*.encrypted-*.bak*`، فلا يمكن إيداع مادة نسخ احتياطية أو مفتاح حزمة قديمة في المستودع.
- **قيم `mode`:** تُمرَّر عند الإنشاء (`0o700` للمجلدات و`0o600` للملفات) لكن `chmodSync` لا يُستدعى على Windows إطلاقًا — كل مواضعه مشروطة بـ `process.platform !== 'win32'` (`store.cjs:141,283,292,300,337,349,357,454,458,550,554,1029,1034,1136,1140`، و`main.cjs:112`) — وWindows لا يعامل `mode` كـ ACL. لذلك صلاحيات الملفات الفعلية مسؤولية من ينشر التطبيق.

## سلامة ملفات الغير

`db:open` لم يعد يحجر ملفًا غير معروف ولا يستبدله ولا ينقله ولا يعيد تسميته. إن كان الملف موجودًا بحجم أكبر من صفر ولم ينجح `classifyStore` في تعريفه، يفشل الفتح برسالة عربية تسمّي المسار كاملًا وتطلب نقل الملف يدويًا إلى مجلد آخر أو استعادة نسخة احتياطية، ويبقى الملف بايتيًا كما هو:

- ملف غريب: «الملف ... ليس قاعدة بيانات معروفة لهذا التطبيق. لم يُعدّل التطبيق الملف ولم ينقله من مكانه.» (`main.cjs:817-822`).
- قاعدة مشغولة في نافذة أخرى (`main.cjs:805`)، أو تالفة (`main.cjs:808`)، أو يتعذر فحصها (`main.cjs:814`): لكل حالة رسالة مستقلة.

مفاتيح استجابة `db:open` كما يعيدها المعالج اليوم (`main.cjs:836-844`):

| المفتاح | النوع | المعنى | المرجع |
|---|---|---|---|
| `success` | منطقي | نجح الفتح أو كانت القاعدة مفتوحة أصلًا | `main.cjs:788`، `main.cjs:837` |
| `quarantined` | `null` دائمًا | حُفظ في العقد للواجهة والسكربتات؛ لم يعد الحجر جزءًا من المسار | `main.cjs:800`، `main.cjs:838` |
| `recoveredFrom` | مسار أو `null` | أحدث نسخة `development-data.db.legacy-passphrase-*.db` موجودة عند بدء متجر جديد لم يكن له ملف صالح؛ هذه الملفات ينشئها إصدار أقدم فقط، فالمسار الحالي لا ينشئها | `main.cjs:830`، `findLegacyBackups()` (`store.cjs:1372`) |
| `backup` | `null` دائمًا | كما أعلاه؛ لا نسخة تُؤخذ قبل الفتح | `main.cjs:801`، `main.cjs:840` |
| `converted` | منطقي | هل وقع تحويل قاعدة مشفّرة في هذا الفتح | `main.cjs:841`، `store.cjs:1163` |
| `encryptedBefore` | منطقي | هل كانت مشفّرة قبل هذا الفتح | `main.cjs:842`، `store.cjs:1163` |
| `backupPath` | مسار أو `null` | مسار النسخة الاحتياطية المرتبطة بالتحويل | `main.cjs:843` |

لم تُغيَّر تسمية أي قناة IPC في هذا التغيير.

## عقد قناة `db:restore` (`main.cjs:891-958`)

الاختيار عبر حوار نظام يقبل `.bak` فقط (`main.cjs:894-898`)، ويُحفظ المسار المختار كما هو ليُرفض الرابط الرمزي بـ `lstat` داخل دالة الاستعادة (`store.cjs:406-412`، `store.cjs:505-511`). مفاتيح الاستجابة كما يعيدها المعالج اليوم:

| المفتاح | النوع | المعنى | المرجع |
|---|---|---|---|
| `canceled` | منطقي | `true` عند إلغاء الحوار، ولا يرافقه مفتاح آخر في الاستجابة | `main.cjs:899` |
| `restored` | منطقي | `true` بعد نجاح التبديل والتحقق وفتح القاعدة المستعادة | `main.cjs:933` |
| `safetyBackup` | مسار أو `null` | نسخة أمان من القاعدة الحالية تُؤخذ **قبل** أي تبديل. المسار الحالي يأخذ لقطة متسقة بعد `wal_checkpoint(TRUNCATE)` عبر `createConsistentBackup` (`main.cjs:857-880`)، لأن المعالج يفرض قاعدة مفتوحة في أوله (`main.cjs:892`)؛ وفرع `backupPlaintextStore` (`main.cjs:909`) احتياطي إن لم تكن القاعدة مفتوحة. `null` إن لم يوجد ملف قاعدة | `main.cjs:906-909`، `main.cjs:934` |
| `filePath` | مسار | المسار الحيّ للقاعدة بعد الاستعادة: `restoredPath` من دالة الاستعادة، وهو مسار القاعدة نفسه لا مسار الحزمة المختارة | `main.cjs:935`، `store.cjs:479`، `store.cjs:579` |
| `converted` | منطقي | هل وقع تحويل مشفّر→عادي عند **فتح** القاعدة المستعادة | `main.cjs:922`، `main.cjs:936` |
| `encryptedBefore` | منطقي | هل كانت القاعدة المستعادة مشفّرة قبل هذا الفتح | `main.cjs:937` |
| `backupPath` | مسار أو `null` | نسخة أنشأها ذلك التحويل أثناء فتح القاعدة المستعادة؛ `null` إذا لم يقع تحويل | `main.cjs:938` |

**اختيار دالة الاستعادة:** إن وُجد `<الملف المختار>.key` تُستدعى `restoreBackupBundle(selected, databasePath, keyPath)` (حزمة مشفّرة قديمة تُستعاد بمفتاحها، ويُنسخ مفتاح الحزمة إلى `store.key`، `store.cjs:399-489`)، وإلا `restorePlaintextBundle(selected, databasePath)` (حزمة عادية بلا مفتاح، و`store.key` القديم لا يُمسّ، `store.cjs:500-588`) — `main.cjs:916-921`.

**ترتيب التنفيذ:** نسخة الأمان (`main.cjs:908-909`) ← إغلاق القاعدة وتصفير المشتقات (`main.cjs:911-914`) ← الاستبدال المُرحَّل مع فحص قوي للمرشّح والمُثبَّت ← إعادة فتح القاعدة وتوليد `sessionId` جديد (`main.cjs:922-924`). إن فشل التبديل أو فشل فتح القاعدة المستعادة، تُستعاد نسخة الأمان وتُفتح من جديد، وإلا يُرفع خطأ يذكر الفشلين معًا (`main.cjs:940-955`).

## عقد قناة `app:status` (`main.cjs:639-672`)

| المفتاح | النوع | المعنى | المرجع |
|---|---|---|---|
| `unlocked` | منطقي | القاعدة مفتوحة في هذه الجلسة | `main.cjs:662` |
| `hasDatabase` | منطقي | يوجد ملف قاعدة موجود وحجمه > صفر (`hasUsableDatabase`، `main.cjs:183`) | `main.cjs:642`، `main.cjs:663` |
| `hasKey` | منطقي | يوجد ملف `store.key` قديم على القرص فقط؛ لا يعني تشفيرًا ولا يمنع الفتح | `main.cjs:664` |
| `plaintext` | منطقي | صحيح فقط إذا كانت القاعدة معروفة كقاعدة عادية لهذا التطبيق (`reason === 'plaintext'`) أو مفتوحة الآن في الجلسة | `main.cjs:652-656`، `main.cjs:665` |
| `encrypted` | منطقي | صحيح فقط إذا كان الملف معروفًا كمشفّر بالمفتاح القديم المتاح (`reason === 'encrypted'` أو `'readable'`) | `main.cjs:653`، `main.cjs:659`، `main.cjs:666` |
| `accessProfile` / `accessProfileLabel` | نص | وضع «المالك/المشاركة» | `main.cjs:667-668`، `security.cjs:37`، `security.cjs:48` |
| `backups` | عدد | عدد ملفات `.bak` في `backups\` قبل الفتح، بلا مسّ الملفات | `main.cjs:670`، `listBackups()` (`store.cjs:375`) |

قاعدة الحساب: قاعدة مشغولة أو تالفة أو غريبة أو غير قابلة للفحص تُعيد `plaintext === false` و`encrypted === false` معًا، فلا تعرض الواجهة حمايةً غير موجودة (`core.test.cjs:194-223`). وهذا سلوك مقصود في الشيفرة لا مصادفة (`main.cjs:643-651`).

**حدّ معروف يجب قوله بصراحة:** ملف غير قاعدة بيانات SQLite ولا يوجد ملف مفتاح إلى جانبه يُصنَّف `encrypted`، لأنه لا يمكن تمييزه عن قاعدة مشفّرة فُقد مفتاحها (`probeFailureReason`، `store.cjs:738-748`). أي أن `encrypted === true` تعني «إما مشفّر حقًا وإما ملف مجهول لا يمكن فتحه»، وليس اكتشافًا كاملًا للتشفير.

## ما يصبح مقروءًا بالضبط

من يملك وصولًا إلى الملف `%APPDATA%\local-development-intelligence\development-data.db` (`getDatabasePath`، `main.cjs:74`) أو إلى أي نسخة داخل `backups\` أو أي `.bak` عادية يقرأ بلا مفتاح وبلا اعتبار لوضع «المشاركة»:

| المجموعة | ما يُقرأ | المرجع |
|---|---|---|
| المديريات وحقولها المقيّدة | `directorates` كاملًا، ومنه `revenue` و`front_line` و`poverty_ratio` و`vulnerable_groups` و`project_cost` و`reviewer_decision` | `store-schema.cjs:112` (الأعمدة مؤكَّدة في مخزن حقيقي) |
| قيم الإدخال والمراجعة | `data_values.value_text`، `review_items.value_text`، `directorate_sources.value_text` | `store-schema.cjs:95`، `:77`، `:163` |
| مصدر القيم وتتبّعها | `value_provenance.original_value_text`/`normalized_value_text`/`source_locator`، `record_field_values.value_text`/`value_boolean`/`raw_value_text`/`normalized_value_text` | `architecture-v1.sql:576`، `architecture-v1.sql:523` |
| قيم النموذج الموحّد | `entity_field_values.value_text`/`value_number`/`raw_value_json` | `canonical-data.cjs:32` |
| التدقيق | `audit_events.old_value_json`/`new_value_json`/`details`، `audit_reads.fields`/`result`/`detail`، `access_log.fields`/`detail` | `architecture-v1.sql:624`، `store-schema.cjs:259`، `store-schema.cjs:233` |
| حِمل النسخ | `directorate_versions.payload_json`، `record_revisions.before_snapshot_json`/`after_snapshot_json`، `entity_record_versions.payload_json`، `indicator_observation_versions.payload_json`، `project_versions.payload_json` | `store-schema.cjs:278`، `architecture-v1.sql:594`، `canonical-data.cjs:30,37,41` |
| الوثائق والمرفقات | `document_records.original_content` (الملف الأصلي كاملًا)، `document_elements.content`/`search_text`، `document_artifacts.content`، `managed_attachments.content` | `document-service.cjs:32`، `:69`، `:61`، `canonical-data.cjs:44` |
| مرشحو الحقول من الوثائق | `document_field_candidates.evidence_text`/`raw_value`/`reviewed_value_json` | `schema-driven-discovery.cjs:24` |
| استيراد المصنفات | `workbook_import_batches.original_file`، `workbook_import_rows.cells_json`، `workbook_import_regions.mapping_json`، `workbook_import_promotions.mapped_values_json`، `workbook_import_media.content` | `canonical-data.cjs:48,52,51,54,56` |
| OCR | `ocr_drafts.text`/`fields_json`، `ocr_field_confidence.raw_text`/`parsed_value` | `store-schema.cjs:295`، `store-schema.cjs:308` |
| نتائج التحليل | `analysis_results.indicators_json`/`gaps_json`/`sensitivity_json`/`missing_json`/`confidence_text` | `store-schema.cjs:207` |

النسخ العادية في `backups\` والنسخ الخارجة عن التطبيق تعرض الشيء نفسه بالكامل. المادة الوحيدة التي تبقى محمية في هذا الوضع هي حزم `<store>.encrypted-*.bak` القديمة، ويبقى ذلك صحيحًا فقط ما دام ملف مفتاحها المرافق (`.bak.key`) محفوظًا.

**حدّ صريح:** الحجب في `security.maskRecord()` (`security.cjs:78`) و`maskDbRows()` (`main.cjs:236`) حجب عرض وتصدير عند حدود IPC فقط، وليس ضبط وصول. قائمة الحقول المحجوبة `security.PROTECTED_KEYS` (`security.cjs:34`)، والتصنيف «مالك/مشاركة» يُختار من الإعدادات. البيانات المخزّنة تبقى كاملة بقصد، ومن يملك وصولًا إلى الملف يقرأ القيمة التي حجبها وضع «المشاركة».

**ما لا يوجد:** لا جدول `document_embeddings` في المخطط الحالي. تحقّقنا من مخزن حقيقي (144 جدولًا) ومن الشجرة كلها فلم نجد أي جدول بهذا الاسم، فليس في الملف اليوم متجهات بحث دلالي تُقرأ أو تُسرَّب. اختيار خدمة التضمين ما زال بند تقييم مفتوحًا (`docs/architecture/local-document-processing-and-search.md:29`).

## الضوابط التعويضية المطلوبة عند النشر

التطبيق لا يوفّر أيًّا من هذه الضوابط، ويجب أن يطبّقها من ينشر النظام:

1. **تشفير القرص بالكامل:** BitLocker (أو ما يعادله) على قرص النظام، لأن القاعدة تسكن مجلد بيانات المستخدم `%APPDATA%\local-development-intelligence\development-data.db` (`main.cjs:74-76`).
2. **حساب Windows مقيّد وصلاحيات NTFS:** حساب تشغيلي محدود، مع ACL على مجلد القاعدة ومجلد `backups\` يمنع القراءة من غير المصرّح لهم. التطبيق لا يضبط أي ACL على Windows (كل `chmodSync` مشروط بغير Windows).
3. **النسخ الاحتياطية مادة سرّية:** كل ملف في `backups\`، وكل `.encrypted-*.bak`، وكل `.bak.key` نسخة كاملة من البيانات؛ تخضع للنسخ الخارجي والتخزين والوسائط بالقدر نفسه الذي تخضع له القاعدة، ولا تُشارك عبر بريد أو وسيط غير محمي.
4. **سياسة احتفاظ وحذف مكتوبة:** التطبيق يبقي أحدث حزمتين مشفّرتين فقط بجوار القاعدة، وأحدث 10 حزم في `backups\`، وهو تقليم تقني لا استبدال لسياسة المنظّمة: على من ينشر تحديد مدة الاحتفاظ وطريقة الحذف الآمن للحزم المشفّرة القديمة بعد التأكد من نجاح التحويل، وللنسخ الخارجة عن التطبيق.

## ما لا يضمنه هذا القرار

- **لا حماية من سرقة القرص أو الجهاز.** نسخ الملف من القرص يقرأ كل شيء.
- **وجود `store.key` لا يضيف حماية.** هو مادة قديمة للقراءة فقط، وليس طبقة تشفير للوضع الحالي.
- **وضع «المشاركة» ليس مصادقة.** لا حسابات ولا كلمات مرور، والوصول إلى التطبيق المفتوح يتبع ضوابط الجهاز.
- **النسخ الاحتياطية العادية ليست محمية.** نسخة في `backups\` أو على وسيط خارجي مقروءة بالقدر نفسه الذي تُقرأ به القاعدة.
- **الحزمة المشفّرة القديمة محمية بمفتاحها وحده.** إن فُقد `.bak.key` أو `store.key` لم يعد ممكنًا فتح الحزمة ولا استعادتها.
- **تصنيف الملف ليس اكتشافًا كاملًا للتشفير** (ملف غير معروف بلا مفتاح يُصنَّف `encrypted`).

## التحقق من كل ادعاء

الأوامر التالية تُنفَّذ من `desktop-app`، وNode 22+ كافٍ لها (`sqlite3` CLI اختياري وغير مثبّت افتراضيًا هنا).

**اختبارات وسكربتات الأدلة**

| الأمر | ما يثبته |
|---|---|
| `node --test tests/plaintext-store.test.cjs tests/core.test.cjs` | 21 اختبارًا موزّعًا على: قاعدة جديدة عادية على القرص بلا مفتاح، عدم توليد مفتاح أبدًا، التحويل مرة واحدة مع بقاء النسخة المشفّرة ومفتاحها، رفض قاعدة مشفّرة بلا مفتاح مع بقائها بايتية كما هي، دورة نسخ/استعادة عادية بلا مفتاح، استعادة حزمة مشفّرة قديمة، تمييز `classifyStore`، عدم مسّ `exportStoreAsPlaintext` للمصدر، رفض الفحص القوي لتوقّع خاطئ ولقاعدة ليست لنا، حالات الانهيار الثلاث (`plaintext-staging`، `encrypted-backup`، والرفض الصريح بلا قاعدة فارغة)، إرجاع الأصل المشفّر وحذف المفتاح المنسوخ عند فشل التحويل، وعدم بقاء أي ملف أو ملف جانبي بعد إعادة الفتح. ومن `core.test.cjs`: رفض `db:open` لملف غريب مع بقائه بايتيًا، ودلالات `app:status` لملف غريب وتالف وقاعدة عادية. |
| `node --test tests/hardening.test.cjs tests/persist.test.cjs` | 36 اختبارًا: النسخ الاحتياطية المشفّرة القديمة مع مفتاحها وملفاتها الجانبية، رفض استعادة حزمة غير صالحة قبل أي تبديل، `copyStoreKey` لا يكتب إلا مفتاحًا صالحًا، `quarantineLegacyDatabase` وتراجع الحجر، والترحيل والواجهة. |
| `npx electron scripts/e2e-analysis.cjs` | على التطبيق الحقيقي: `unlocked === true && plaintext === true && encrypted === false` (`scripts/e2e-analysis.cjs:318-319`)، وترويسة الملف على القرص (`:320-322`)، والاستعادة من الواجهة (`:367`). |
| `$env:E2E_SEED_ENCRYPTED_STORE='1'; npx electron scripts/e2e-analysis.cjs` | يزرع قاعدة مشفّرة بـ `openEncryptedStore` مع `store.key` (`scripts/e2e-analysis.cjs:43-52`) ويثبت التحويل التلقائي وبقاء `.encrypted-*.bak` مع مفتاحه ووجود نسخة في `backups\` (`:323-331`). |
| `node C:\Users\Administrator\AppData\Local\Temp\opencode\plaintext-rehearsal.cjs` | تمرين طرفي على **نسخة** من المخزن الحقيقي عبر مسار الإنتاج نفسه `store.openOrConvertStore()`؛ مجلد البيانات الحقيقي يُقرأ فقط وتقع كل الكتابات في مجلد مؤقت. ملاحظة: هذا سكربت مطوّر محلي تحت `%TEMP%` وليس جزءًا من المستودع. |
| `git diff --name-only -- '*.sql'` | يجب أن يكون فارغًا: لم يُعدّل أي ملف مخطط أو ترحيل (تم التحقق: فارغ). |

**فحص الملف نفسه (بلا أدوات إضافية)** — بعد إغلاق التطبيق:

```powershell
$env:DIR = "$env:APPDATA\local-development-intelligence"
$env:DB  = "$env:DIR\development-data.db"

# ترويسة SQLite عادية في أول 16 بايت
node -e "const fs=require('fs');const h=fs.readFileSync(process.env.DB).subarray(0,16).toString('latin1');console.log(h==='SQLite format 3\u0000'?'PLAINTEXT-SQLITE':'NOT-PLAINTEXT')"

# يُفتح بلا مفتاح
node -e "const D=require('better-sqlite3-multiple-ciphers');const db=new D(process.env.DB,{readonly:true,timeout:2000});console.log('keyless-open-ok objects='+db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n);db.close();"
```

**فحص العلامة والحزم المحفوظة والمخلفات:**

```powershell
# علامة التحويل: وجودها يعني أن التطبيق سيعالج الحالة عند التشغيل التالي بدلًا من بناء قاعدة فارغة
Get-ChildItem "$env:DIR\development-data.db.plaintext-conversion.json" -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_.FullName -Raw }

# الحزم المشفّرة المحفوظة (أحدث حزمتين كحد أقصى) ومفتاح كل واحدة
Get-ChildItem "$env:DIR" -Filter "development-data.db.encrypted-*.bak*"

# النسخ الاحتياطية العادية
Get-ChildItem "$env:DIR\backups" -Filter "*.bak"

# المخلفات التي يُنظّفها بدء التشغيل (يُفترض ألا يبقى منها شيء بعد تشغيل ناجح)
Get-ChildItem "$env:DIR" | Where-Object { $_.Name -match 'development-data\.db\.(plaintext-|restore-|rollback-)' }
```

**جدول: الادعاء ← المرجع**

| الادعاء | المرجع |
|---|---|
| القاعدة عادية وتُفتح بلا مفتاح | `openStore()` — `store.cjs:658`؛ `openOrConvertStore()` — `store.cjs:1348` |
| لا يُولَّد مفتاح لقاعدة جديدة | `loadOrCreateStoreKey()` — `store.cjs:99-123`؛ `openOrConvertStore()` — `store.cjs:1337-1344` |
| التحويل يقع مرة واحدة عند أول فتح | `openOrConvertStore()` — `store.cjs:1346-1368`؛ `convertEncryptedStoreInPlace()` — `store.cjs:1108` |
| الآلية: نسخة بثّية بذاكرة ثابتة ثم `PRAGMA rekey = ''` الذي يُعيد البناء عبر VACUUM مؤقت | `exportStoreAsPlaintext()` — `store.cjs:1028`، `store.cjs:1050`؛ التوثيق: `node_modules/better-sqlite3-multiple-ciphers/README.md:105`؛ فرع فك التشفير: `deps/sqlite3/sqlite3.c:339695-339707`، `sqlite3.c:338945` |
| فحص الترويسة قراءة 16 بايت لا قراءة الملف كاملًا | `readFileHeader()` — `store.cjs:799-808` |
| الفحص القوي على المرشّح والمثبَّت وفي مساري الاستعادة | `verifyStoreIdentity()` — `store.cjs:895`؛ `store.cjs:558`، `:572`، `:463`، `:475`، `:1065`، `:1154` |
| علامة التحويل ومحتواها | `writeConversionMarker()` — `store.cjs:947`؛ `store.cjs:1118-1129` |
| استرجاع الانهيار بحالاته الأربع | `recoverInterruptedConversion()` — `store.cjs:1217-1303` |
| تنظيف المخلفات دون لمس ما تشير إليه العلامة | `pruneConversionLeftovers()` — `store.cjs:217-261` |
| الاحتفاظ بأحدث حزمتين مشفّرتين وحذف المفتاح مع الحزمة | `pruneEncryptedOriginals()` — `store.cjs:175-205`؛ `KEPT_ENCRYPTED_BACKUPS` — `store.cjs:17` |
| منع إيداع مادة النسخ في Git | `.gitignore:40-42` |
| `db:open` يرفض ملفًا غير معروف بلا تعديله | `main.cjs:803-823`؛ `tests/core.test.cjs:164-192` |
| `db:restore` يأخذ نسخة أمان قبل التبديل ويختار دالة الاستعادة بحسب وجود `.key` | `main.cjs:891-958`؛ `restoreBackupBundle()` — `store.cjs:399-489`؛ `restorePlaintextBundle()` — `store.cjs:500-588` |
| دلالات `app:status` ولا تعرض حماية غير موجودة | `main.cjs:639-672`؛ `tests/core.test.cjs:194-237` |
| الحجب في وضع المشاركة حجب عرض لا ضبط وصول | `security.maskRecord()` — `security.cjs:78`؛ `maskDbRows()` — `main.cjs:236` |
| التطبيق لا يضبط ACL على Windows | كل `chmodSync` مشروط بـ `process.platform !== 'win32'` — `store.cjs:141,283,292,300,337,349,357,454,458,550,554,1029,1034,1136,1140`، `main.cjs:112` |

## ما لم يتغيّر

- المخطط والجداول والأعمدة: `desktop-app/src/main/analysis/store-schema.cjs`، `desktop-app/src/main/database/architecture-v1.sql`، `desktop-app/src/main/database/unified-development-model-v2.sql`، وتعريفات الجداول في `desktop-app/src/main/analysis/canonical-data.cjs` و`desktop-app/src/main/documents/document-service.cjs`.
- الترحيلات وسلامتها: `desktop-app/src/main/database/migration-integrity.cjs` والملفات `.sql` (تحقّق: `git diff --name-only -- '*.sql'` فارغ).
- تسميات قنوات IPC: لم تُضف ولم تُحذف ولم تُغيَّر تسمية أي قناة `ipcMain.handle`.
- التعديل الوحيد على `canonical-data.cjs` هو نص وصفي في `canonical-data.cjs:395` كان يصف القاعدة بأنها مشفّرة، وأُبدل بوصف قاعدة SQLite محلية غير مشفّرة.
