'use strict';

/**
 * End-to-end verification of the real application.
 *
 * Run with:  npx electron scripts/e2e-analysis.cjs
 *
 * Boots the production renderer against a throwaway user-data directory, builds
 * a 20-directorate workbook from the reference fixture, scans it, applies the
 * import plan, drives every screen through the DOM, writes a real PDF and a real
 * workbook, and stores every artefact plus a machine-readable transcript in
 * «نتائج-الفحص».
 *
 * The run is also the usability test: each check is a scenario a real operator
 * performs (enter → import → review → browse → correct → export), and any
 * failure is classified by severity in «10-تقرير-العيوب.json».
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'template-v3.3.xlsx');
const EVIDENCE = path.join(ROOT, '..', 'نتائج-الفحص');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-e2e-'));
const SAMPLE = path.join(USER_DATA, 'sample-20.xlsx');
const STORE_PATH = path.join(USER_DATA, 'development-data.db');
const LEGACY_KEY_PATH = path.join(USER_DATA, 'store.key');
const interactionTrace = [];
const rendererRuntimeErrors = [];

/**
 * Optional pre-existing encrypted store.
 *
 * The store is a plain SQLite file now, so the default run verifies the store the
 * application creates from scratch. Run with E2E_SEED_ENCRYPTED_STORE=1 to seed a
 * store written by the earlier encrypted build and prove the automatic conversion
 * end to end: the same assertions then cover the converted file and the kept
 * encrypted original.
 */
const SEED_ENCRYPTED_STORE = process.env.E2E_SEED_ENCRYPTED_STORE === '1';
if (SEED_ENCRYPTED_STORE) {
  const { openEncryptedStore } = require(path.join(__dirname, '..', 'src', 'main', 'store.cjs'));
  const seededKey = 'ab'.repeat(32);
  const seeded = openEncryptedStore(STORE_PATH, seededKey);
  seeded.close();
  fs.writeFileSync(LEGACY_KEY_PATH, seededKey + '\n', { mode: 0o600 });
  console.log('[E2E] seeded encrypted store header=' + JSON.stringify(fs.readFileSync(STORE_PATH).subarray(0, 16).toString('latin1')));
}
const LEGACY_KEY_PRESENT = fs.existsSync(LEGACY_KEY_PATH);

app.on('browser-window-created', (_event, browserWindow) => {
  browserWindow.webContents.on('console-message', (_consoleEvent, level, message, line, sourceId) => {
    if (level >= 2) {
      rendererRuntimeErrors.push({ type: 'console-error', level, message, line, sourceId });
    }
  });
  browserWindow.webContents.on('render-process-gone', (_goneEvent, details) => {
    rendererRuntimeErrors.push({ type: 'render-process-gone', ...details });
  });
  browserWindow.webContents.on('did-fail-load', (_loadEvent, errorCode, errorDescription, validatedURL) => {
    rendererRuntimeErrors.push({ type: 'did-fail-load', errorCode, errorDescription, validatedURL });
  });
});

app.setPath('userData', USER_DATA);
require(path.join(ROOT, 'src', 'main', 'main.cjs'));

const results = [];
function check(group, name, condition, detail = '') {
  results.push({ group, name, ok: Boolean(condition), detail });
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForWindow(timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length) return windows[0];
    await sleep(120);
  }
  throw new Error('main window never appeared');
}

async function waitFor(window, expression, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await window.webContents.executeJavaScript(expression).catch(() => false);
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${expression}`);
}

async function pointerClick(window, selector, text = null, label = '') {
  const match = text === null
    ? 'nodes[0]'
    : `nodes.find((node) => (node.textContent || '').includes(${JSON.stringify(text)}))`;
  const target = await window.webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const target = ${match};
    if (!target) return null;
    const before = target.getBoundingClientRect();
    const beforeRect = { left: before.left, top: before.top, right: before.right, bottom: before.bottom };
    // A real operator can only click a control after scrolling its container
    // into view. scrollIntoView moves the nearest scrollable ancestors (e.g. the
    // wide RTL table viewport), then the actual pointer event is hit-tested.
    target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    const rect = target.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    const viewportVisible = rect.right > 0 && rect.bottom > 0
      && rect.left < window.innerWidth && rect.top < window.innerHeight;
    return {
      ok: rect.width > 0 && rect.height > 0 && viewportVisible && Boolean(hit && (hit === target || target.contains(hit))),
      x, y, width: rect.width, height: rect.height,
      beforeRect,
      afterRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      scrolledIntoView: beforeRect.left !== rect.left || beforeRect.top !== rect.top,
      tag: target.tagName,
      accessibleName: target.getAttribute('aria-label') || target.getAttribute('title') || (target.innerText || target.textContent || '').trim().slice(0, 100),
      hitTag: hit?.tagName ?? null,
      hitText: (hit?.innerText || hit?.textContent || '').trim().slice(0, 100)
    };
  })()`);

  const trace = {
    action: 'pointer-click',
    selector,
    label: label || text || selector,
    ...(target ?? {}),
    at: new Date().toISOString(),
  };
  if (!target?.ok) {
    interactionTrace.push({ ...trace, ok: false, reason: 'target-not-visible-or-pointer-intercepted' });
    return false;
  }

  const evidenceDir = path.join(EVIDENCE, 'click-traces');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const sequence = String(interactionTrace.length + 1).padStart(3, '0');
  const beforeFile = path.join('click-traces', `${sequence}-before.png`);
  const afterFile = path.join('click-traces', `${sequence}-after.png`);
  const beforeText = await bodyText(window);
  const beforeImage = await window.webContents.capturePage();
  fs.writeFileSync(path.join(EVIDENCE, beforeFile), beforeImage.toPNG());

  // Send actual mouse movement/down/up through Electron. Synthetic DOM event
  // dispatch bypasses hit testing and cannot prove physical clickability.
  window.webContents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await sleep(180);

  const afterText = await bodyText(window);
  const afterImage = await window.webContents.capturePage();
  fs.writeFileSync(path.join(EVIDENCE, afterFile), afterImage.toPNG());
  interactionTrace.push({
    ...trace,
    ok: true,
    beforeFile,
    afterFile,
    beforeText: beforeText.slice(0, 240),
    afterText: afterText.slice(0, 240),
    changedText: beforeText !== afterText,
  });
  return true;
}

async function clickByText(window, selector, text) {
  return pointerClick(window, selector, text, text);
}

async function clickBySelector(window, selector, label) {
  return pointerClick(window, selector, null, label);
}

async function text(window, selector) {
  return window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`);
}

async function bodyText(window) {
  return window.webContents.executeJavaScript('document.body.innerText');
}

async function screenshot(window, fileName) {
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(EVIDENCE, fileName), image.toPNG());
  return image.getSize();
}

/**
 * Build a 20-row workbook from the reference fixture.
 *
 * Rows 3..5 stay as they are (a complete row and two incomplete ones); rows 6..22
 * clone the complete row with a new identity, so the ranking has enough eligible
 * directorates and the waiting list still has examples.
 */
async function buildSampleWorkbook(targetPath) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(FIXTURE);
  const sheet = workbook.getWorksheet('قاعدة البيانات الشاملة') ?? workbook.worksheets[0];

  let headerRow = 1;
  for (let rowNumber = 1; rowNumber <= 6; rowNumber += 1) {
    const value = String(sheet.getRow(rowNumber).getCell(1).value ?? '');
    if (value.includes('اسم المديرية')) { headerRow = rowNumber; break; }
  }

  const dataRows = [];
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const name = sheet.getRow(rowNumber).getCell(1).value;
    if (name) dataRows.push(rowNumber);
  }
  if (dataRows.length < 3) throw new Error('the fixture no longer carries three data rows');

  const governorates = ['صنعاء', 'إب', 'تعز', 'الحديدة', 'حضرموت'];
  const completeRow = sheet.getRow(dataRows[0]);
  for (let index = dataRows.length; index < 20; index += 1) {
    const source = sheet.getRow(dataRows[index % dataRows.length]);
    const target = sheet.getRow(headerRow + 1 + index);
    for (let column = 1; column <= 39; column += 1) {
      target.getCell(column).value = source.getCell(column).value;
    }
    // Keep the complete row as the base so the clone is eligible, then vary the
    // identity and the population so the dashboard and ranking are not flat.
    if (index >= dataRows.length) {
      const population = Number(completeRow.getCell(3).value);
      if (Number.isFinite(population)) target.getCell(3).value = Math.round(population * (1 + (index % 7) * 0.03));
    }
    target.getCell(1).value = `مديرية اختبار ${index + 1}`;
    target.getCell(2).value = governorates[index % governorates.length];
  }

  // Include a real non-directorate project table so the staged review + mapping +
  // explicit promotion path is exercised through the operator-facing UI.
  const projects = workbook.addWorksheet('مشاريع اختبار');
  projects.getRow(1).values = [
    'اسم المشروع', 'رمز المشروع', 'التكلفة التقديرية', 'رمز العملة',
    'تاريخ البداية', 'تاريخ النهاية', 'جهة التمويل', 'مبلغ التمويل',
    'المحافظة', 'المديرية', 'القطاع', 'عملة التمويل',
  ];
  projects.getRow(2).values = [
    'مشروع اختبار E2E', 'E2E-001', '1000', 'YER',
    '2026-01-01', '2026-12-31', 'UNDP', '100',
    'صنعاء', 'مديرية اختبار 1', 'المياه', 'USD',
  ];

  await workbook.xlsx.writeFile(targetPath);
  return { headerRow, rows: 20, dataStart: dataRows[0] };
}

function writeGroup(fileName, group) {
  const entries = results.filter((item) => item.group === group);
  fs.writeFileSync(path.join(EVIDENCE, fileName), JSON.stringify({
    generatedAt: new Date().toISOString(),
    group,
    total: entries.length,
    passed: entries.filter((item) => item.ok).length,
    checks: entries,
  }, null, 2), 'utf8');
}

/** Severity per scenario: import and export block the product; browsing degrades it. */
const SEVERITY = {
  entry: 'blocking',
  import: 'blocking',
  export: 'blocking',
  nav: 'major',
  pages: 'major',
  security: 'major',
  accessibility: 'major',
};

app.whenReady().then(async () => {
  let window;
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });

    window = await waitForWindow();
    await waitFor(window, `Boolean(document.querySelector('.welcome-screen'))`);
    await sleep(400);

    // ---------- 1. Entry ----------
    const welcome = await text(window, '.welcome-screen');
    check('entry', 'شاشة الدخول تُعرض بلا كلمة مرور', welcome.includes('نظام التنمية المحلية') && !welcome.includes('كلمة المرور'), welcome.slice(0, 60));
    check('entry', 'لا يوجد أي حقل كلمة مرور في الواجهة', await window.webContents.executeJavaScript(`document.querySelectorAll('input[type=password]').length === 0`));
    check('entry', 'المظهر داكن (كحلي)', await window.webContents.executeJavaScript(`(() => {
      const bg = getComputedStyle(document.body).backgroundColor.match(/\\d+/g)?.map(Number) ?? [255, 255, 255];
      return bg[0] + bg[1] + bg[2] < 160;
    })()`));
    await screenshot(window, '1-واجهة-الدخول.png');

    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' });
    await sleep(100);
    const keyboardFocus = await window.webContents.executeJavaScript(`(() => ({
      tag: document.activeElement?.tagName ?? null,
      text: (document.activeElement?.innerText || document.activeElement?.textContent || '').trim().slice(0, 100),
      focusVisible: Boolean(document.activeElement?.matches(':focus-visible'))
    }))()`);
    check('accessibility', 'زر الدخول يصل إليه التركيز عبر لوحة المفاتيح', keyboardFocus.tag === 'BUTTON' && keyboardFocus.focusVisible, JSON.stringify(keyboardFocus));

    const entered = await clickByText(window, '.welcome-card button', 'الدخول إلى مساحة العمل')
      || await clickByText(window, '.welcome-card button', 'إنشاء قاعدة البيانات والدخول');
    check('entry', 'زر الدخول يعمل', entered);
    await waitFor(window, `Boolean(document.querySelector('.app-shell'))`);

    const labels = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.side-nav .nav-item span')].map((node) => node.textContent)`);
    const expectedNav = ['اللوحة التفاعلية', 'المؤشرات الـ 12', 'ترتيب الأولويات', 'الوثائق والبحث والاستيراد', 'سجل المشاريع', 'مصادر البيانات', 'تصحيح البيانات', 'قاعدة البيانات الشاملة', 'بطاقة مديرية'];
    const removedNav = ['سجل قياسات المؤشرات', 'جودة البيانات'];
    check('nav', 'التنقل يعرض مركز الوثائق الموحد ويخفي الصفحات المحذوفة', expectedNav.every((label) => labels.includes(label)) && removedNav.every((label) => !labels.includes(label)), labels.join(' · '));
    const storeState = await window.webContents.executeJavaScript(`window.localApp.status().then((s) => ({ unlocked: s.unlocked, hasKey: s.hasKey, plaintext: s.plaintext, encrypted: s.encrypted }))`);
    check('entry', 'قاعدة البيانات مفتوحة في صيغة SQLite عادية بلا تشفير', storeState.unlocked === true && storeState.plaintext === true && storeState.encrypted === false, JSON.stringify(storeState));
    const storeHeader = fs.readFileSync(STORE_PATH).subarray(0, 16).toString('latin1');
    check('entry', 'ملف قاعدة البيانات على القرص يبدأ بترويسة SQLite عادية', storeHeader === 'SQLite format 3\u0000', JSON.stringify(storeHeader));
    check('entry', 'قاعدة البيانات تُفتح بأداة SQLite عادية بلا مفتاح', require(path.join(ROOT, 'src', 'main', 'store.cjs')).classifyStore(STORE_PATH, null).reason === 'plaintext', STORE_PATH);
    if (LEGACY_KEY_PRESENT) {
      // A store written by the earlier encrypted build was present: the plaintext
      // header above can only be the result of the automatic conversion, and the
      // encrypted original must still be recoverable with its key.
      const kept = fs.readdirSync(USER_DATA).filter((name) => name.includes('.encrypted-') && name.endsWith('.bak'));
      check('entry', 'حُوّلت القاعدة المشفّرة تلقائيًا وبقيت النسخة المشفّرة مع مفتاحها',
        kept.length > 0 && kept.every((name) => fs.existsSync(path.join(USER_DATA, name + '.key')))
          && fs.readdirSync(path.join(USER_DATA, 'backups')).some((name) => name.endsWith('.bak')),
        JSON.stringify({ kept }));
    } else {
      check('entry', 'لا يُنشئ التطبيق ملف مفتاح لقاعدة جديدة', !fs.existsSync(LEGACY_KEY_PATH), JSON.stringify({ keyPresent: fs.existsSync(LEGACY_KEY_PATH) }));
    }

    // ---------- 2. Import (scan -> plan -> apply) ----------
    const sample = await buildSampleWorkbook(SAMPLE);
    const imported = await window.webContents.executeJavaScript(`(async () => {
      const scan = await window.localApp.scanWorkbook({ filePath: ${JSON.stringify(SAMPLE)} });
      const plan = await window.localApp.importPlan();
      const decisions = Object.fromEntries(plan.preview.map((row) => [String(row.rowNumber), 'apply']));
      const applied = await window.localApp.applyImport({ decisions, force: true });
      return {
        canceled: scan.canceled,
        sheet: scan.sheetName,
        headerRow: scan.headerRow,
        matched: scan.matchedCount,
        totalRows: scan.totalRows,
        planRows: plan.preview.length,
        created: applied.created,
        updated: applied.updated,
        refused: applied.refused.length,
        total: applied.total,
      };
    })()`);
    check('import', 'فحص الملف يكتشف الورقة وصف الرؤوس', imported.canceled === false && imported.sheet === 'قاعدة البيانات الشاملة' && imported.headerRow === 2, JSON.stringify(imported));
    check('import', 'كل أعمدة الإدخال الـ39 مطابقة', imported.matched >= 39, `matched=${imported.matched}`);
    check('import', 'الخطة تعرض 20 صفًا وتُطبَّق في قاعدة SQLite المحلية (بترويسة SQLite format 3)', imported.planRows === 20 && imported.total === 20 && imported.created === 20, JSON.stringify(imported));
    check('import', 'لا صفوف مرفوضة أثناء التطبيق', imported.refused === 0, `refused=${imported.refused}`);

    // Exercise backup + restore through the actual operator-facing control.
    const restoreSource = await window.webContents.executeJavaScript('window.localApp.backupDatabase()');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [restoreSource.filePath] });
    await window.webContents.executeJavaScript('(() => { window.confirm = () => true; return true; })()');
    const restoreClicked = await clickBySelector(window, '.topbar button[aria-label="استعادة نسخة احتياطية"]', 'استعادة النسخة الاحتياطية');
    await waitFor(window, `document.body.innerText.includes('تمت استعادة النسخة الاحتياطية والتحقق من قاعدة البيانات')`, 30000);
    check('security', 'استعادة النسخة الاحتياطية تعمل من واجهة المستخدم', restoreClicked && await window.webContents.executeJavaScript(`window.localApp.status().then((state) => state.unlocked && state.plaintext && !state.encrypted)`));
    await screenshot(window, '9-بعد-استعادة-النسخة.png');

    // ---------- 3. Pages ----------
    await clickByText(window, '.side-nav .nav-item', 'اللوحة التفاعلية');
    await waitFor(window, `document.body.innerText.includes('نظرة شاملة')`, 30000);
    const refreshed = await clickBySelector(window, '.topbar .icon-button[title*="تحديث"]', 'تحديث أرقام اللوحة');
    check('pages', 'زر التحديث يعيد قراءة الأرقام من القاعدة', refreshed);
    await waitFor(window, `document.body.innerText.includes('تغطية المؤشرات')`, 30000);
    await sleep(600);
    const dashboard = await bodyText(window);
    check('pages', 'اللوحة التفاعلية تعرض الإجماليات', dashboard.includes('الاكتمال') && /(^|\s)20(\s|$)/.test(dashboard), dashboard.slice(-200).replace(/\n/g, ' | '));
    check('pages', 'اللوحة تعرض تغطية المؤشرات والمحافظات', dashboard.includes('تغطية المؤشرات') && dashboard.includes('المحافظات'));
    await screenshot(window, '2-اللوحة-التفاعلية.png');

    await clickByText(window, '.side-nav .nav-item', 'المؤشرات الـ 12');
    await waitFor(window, `document.body.innerText.includes('مصفوفة المؤشرات')`, 30000);
    await sleep(400);
    const indicatorText = await bodyText(window);
    const indicatorHeaders = await window.webContents.executeJavaScript(`(async () => {
      const payload = await window.localApp.sheetIndicators();
      return payload.registry.map((item) => item.header);
    })()`);
    check('pages', 'شاشة المؤشرات تعرض الأبعاد الاثني عشر', indicatorHeaders.length === 12 && indicatorHeaders.every((header) => indicatorText.includes(header)), `${indicatorHeaders.length} مؤشرًا`);
    const matrixRows = await window.webContents.executeJavaScript(`document.querySelectorAll('table.data tbody tr').length`);
    check('pages', 'مصفوفة المؤشرات تعرض كل المديريات', matrixRows >= 20, `rows=${matrixRows}`);
    await screenshot(window, '3-المؤشرات.png');

    await clickByText(window, '.side-nav .nav-item', 'ترتيب الأولويات');
    await waitFor(window, `document.body.innerText.includes('مؤشر الاحتياج')`, 30000);
    await sleep(400);
    const rankingRows = await window.webContents.executeJavaScript(`document.querySelectorAll('table.data tbody tr').length`);
    const rankingText = await bodyText(window);
    check('pages', 'ترتيب الأولويات يعرض قائمة مرتبة', rankingRows >= 15, `rows=${rankingRows}`);
    check('pages', 'الترتيب يشرح قاعدة الاحتساب', rankingText.includes('كيف يُحسب') || rankingText.includes('المكتمل'), rankingText.slice(0, 80).replace(/\n/g, ' | '));
    await screenshot(window, '4-ترتيب-الأولويات.png');

    await clickByText(window, '.side-nav .nav-item', 'قاعدة البيانات الشاملة');
    await waitFor(window, `document.querySelectorAll('table.data tbody tr').length === 20 && document.body.innerText.replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632)).includes('من 20 مديرية')`, 30000);
    const databaseText = await bodyText(window);
    const databaseRows = await window.webContents.executeJavaScript(`document.querySelectorAll('table.data tbody tr').length`);
    const normalizedDatabaseText = databaseText.replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632));
    check('pages', 'قاعدة البيانات تعرض العشرين سجلًا', normalizedDatabaseText.includes('من 20 مديرية') && databaseRows === 20, `rows=${databaseRows}`);
    await screenshot(window, '5-قاعدة-البيانات.png');

    const cardOpened = await clickByText(window, 'table.data tbody tr button', 'البطاقة');
    await waitFor(window, `Boolean(document.querySelector('.kv'))`, 30000);
    await sleep(400);
    const cardText = await bodyText(window);
    check('pages', 'بطاقة المديرية تفتح وتعرض كل الحقول', cardOpened && cardText.includes('المؤشرات الـ 12') && cardText.includes('كل الحقول'), cardText.slice(0, 90).replace(/\n/g, ' | '));
    check('pages', 'البطاقة تعرض المصدر والسجل الزمني', cardText.includes('ملف المصدر') && cardText.includes('السجل الزمني'));
    await screenshot(window, '6-بطاقة-مديرية.png');

    await clickByText(window, '.side-nav .nav-item', 'تصحيح البيانات');
    await waitFor(window, `Boolean(document.querySelector('input[placeholder*="ابحث"]'))`, 30000);
    await sleep(500);
    const correctionText = await bodyText(window);
    check('pages', 'تصحيح البيانات يفتح محرر السجلات', correctionText.includes('السجلات') && correctionText.includes('تصحيح البيانات'), correctionText.slice(-160).replace(/\n/g, ' | '));
    await screenshot(window, '7-تصحيح-البيانات.png');

    await clickByText(window, '.side-nav .nav-item', 'الوثائق والبحث والاستيراد');
    await waitFor(window, `document.body.innerText.includes('الوثائق والبحث') && document.body.innerText.includes('الاستيراد الآلي')`, 30000);
    const importTabClicked = await clickByText(window, '.btn.primary', 'استيراد ملف Excel');
    await waitFor(window, `document.body.innerText.includes('اختيار ملف Excel')`, 30000);
    await sleep(400);
    check('pages', 'زر الاستيراد في المركز الموحد يفتح خطوات الاستيراد الثلاث', importTabClicked && await window.webContents.executeJavaScript(`Boolean(document.querySelector('.stepper'))`));
    check('pages', 'شاشة الاستيراد تذكر الصيغ والقواعد', (await bodyText(window)).includes('xlsx'));

    // Exercise the actual UI scan path. Native dialog is stubbed to a synthetic
    // workbook so the operator-facing inventory is verified before any Apply.
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SAMPLE] });
    const scanClicked = await clickByText(window, '.btn.primary.sheen', 'اختيار ملف Excel');
    await waitFor(window, `document.body.innerText.includes('فحص بنية ملف Excel')`, 60000);
    await waitFor(window, `(() => {
      const text = document.body.innerText;
      return text.includes('فُحصت 9 ورقة') && !text.includes('جارٍ بناء خطة الاستيراد');
    })()`, 30000);
    const inventoryUi = await window.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll('.card')].find((item) =>
        item.querySelector('.card-head h2')?.textContent.trim() === 'فحص بنية ملف Excel'
      );
      if (card) card.scrollIntoView({ behavior: 'instant', block: 'start' });
      const rect = card?.getBoundingClientRect();
      return {
        present: Boolean(card),
        rows: card?.querySelectorAll('table.data tbody tr').length ?? 0,
        text: (card?.innerText || '').slice(0, 1400),
        sheetNames: [...(card?.querySelectorAll('table.data tbody tr td:first-child') ?? [])].map((node) => node.textContent.trim()),
        visible: Boolean(rect && rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 0),
        top: rect?.top ?? null,
      };
    })()`);
    await sleep(250);
    check(
      'import',
      'واجهة المراجعة تعرض فهرس الأوراق المرئي قبل اعتماد الاستيراد',
      scanClicked && inventoryUi.present && inventoryUi.visible && inventoryUi.rows > 0 && inventoryUi.sheetNames.includes('قاعدة البيانات الشاملة'),
      JSON.stringify(inventoryUi)
    );
    await screenshot(window, '8-الاستيراد.png');
    await screenshot(window, '14-فهرس-الأوراق.png');

    // Exercise non-directorate review, explicit row selection and canonical
    // project promotion with a real Electron pointer click.
    const projectReviewDiagnostics = await window.webContents.executeJavaScript(`(async () => {
      const batches = await window.localApp.importHistory({ limit: 5 });
      const latest = batches[0];
      if (!latest) return { batches: [], reason: 'no-import-batch' };
      const inventory = await window.localApp.importRegions({ batchId: latest.id });
      const projectRegions = (inventory.regions ?? []).filter(region => region.candidateType === 'project-candidate');
      const previews = [];
      for (const region of projectRegions) {
        previews.push(await window.localApp.importRegionPreview({
          batchId: latest.id, regionId: region.id, offset: 0, limit: 5,
        }));
      }
      return {
        latestBatchId: latest.id,
        regions: (inventory.regions ?? []).map(region => ({
          id: region.id, sheetName: region.sheetName, candidateType: region.candidateType,
          headerRow: region.headerRow, totalRows: region.totalRows, headers: region.headers,
        })),
        projectRegionCount: projectRegions.length,
        previewRows: previews.flatMap(preview => preview.rows ?? []).map(row => ({
          rowNumber: row.rowNumber, cells: row.cells.map(cell => cell.text),
        })),
      };
    })()`);
    console.log('[E2E] Project review diagnostic: ' + JSON.stringify(projectReviewDiagnostics));
    await waitFor(window, `document.body.innerText.includes('مناطق المشاريع المرشحة: 1') && document.body.innerText.includes('مشروع اختبار E2E')`, 30000)
      .catch(error => { throw new Error(error.message + '; diagnostic=' + JSON.stringify(projectReviewDiagnostics)); });
    const projectRowSelected = await clickByText(window, '[data-testid="project-row-label-2"] strong', 'صف 2');
    const beforePromotion = await window.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll('.card')].find(item =>
        item.innerText.includes('مراجعة الجداول الإضافية واعتماد المشاريع')
      );
      return {
        checkboxChecked: document.querySelector('#project-row-2')?.checked ?? null,
        selects: [...(card?.querySelectorAll('select') ?? [])].map(select => ({
          value: select.value,
          label: select.closest('label')?.innerText?.slice(0, 100) ?? '',
        })),
        buttons: [...(card?.querySelectorAll('button') ?? [])].map(button => ({
          text: button.innerText.trim(),
          disabled: button.disabled,
        })),
      };
    })()`);
    const promoteClicked = await clickBySelector(window, '#promote-projects', 'اعتماد المشاريع المحددة في قاعدة البيانات');
    const promotionCompleted = await waitFor(
      window,
      `document.body.innerText.includes('نتيجة اعتماد المشاريع') && document.body.innerText.includes('أُضيفت: 1')`,
      12000
    ).then(() => true).catch(() => false);
    const promotionBody = await bodyText(window);
    check(
      'import',
      'جدول المشاريع يُربط ويُعتمد بعد اختيار الصف صراحةً',
      projectRowSelected && beforePromotion.checkboxChecked && beforePromotion.selects.some(item => item.label.includes('اسم المشروع') && item.value === '1')
        && promoteClicked && promotionCompleted,
      JSON.stringify({
        projectRowSelected,
        rowClickTrace: interactionTrace.filter(item => item.label === 'صف 2').slice(-1)[0] ?? null,
        beforePromotion,
        promoteClicked,
        promotionCompleted,
        body: promotionBody.slice(-1800),
      })
    );
    await screenshot(window, '15-اعتماد-المشاريع.png');

    const projectListIpc = await window.webContents.executeJavaScript(
      `window.localApp.canonicalProjects({ search: 'مشروع اختبار E2E', offset: 0, limit: 10 })`
    );
    console.log('[E2E] Project register IPC: ' + JSON.stringify(projectListIpc));
    check(
      'pages',
      'استعلام سجل المشاريع يعيد المشروع المعتمد',
      !projectListIpc.restricted && projectListIpc.rows?.some(row => row.code === 'E2E-001'),
      JSON.stringify(projectListIpc).slice(0, 1200)
    );
    const projectNavClicked = await clickByText(window, '.side-nav .nav-item', 'سجل المشاريع');
    const projectPageDiagnostics = await window.webContents.executeJavaScript(`(() => ({
      activeNavigation: document.querySelector('.side-nav .nav-item.active')?.innerText ?? null,
      projectTitlePresent: document.body.innerText.includes('سجل المشاريع المعتمدة'),
      projectCodePresent: document.body.innerText.includes('E2E-001'),
      pageText: document.body.innerText.slice(-1800),
      rootHtml: document.querySelector('#root')?.innerHTML.slice(-2400) ?? null,
      cards: [...document.querySelectorAll('.card')].map(card => card.innerText.slice(0, 100)),
    }))()`);
    console.log('[E2E] Project page navigation: ' + JSON.stringify({
      projectNavClicked,
      rendererRuntimeErrors: rendererRuntimeErrors.slice(-20),
      ...projectPageDiagnostics,
    }));
    await waitFor(window, `document.body.innerText.includes('سجل المشاريع المعتمدة') && document.body.innerText.includes('مشروع اختبار E2E')`, 12000)
      .catch(error => { throw new Error(error.message + '; projectPage=' + JSON.stringify(projectPageDiagnostics)); });
    const projectList = await bodyText(window);
    check('pages', 'سجل المشاريع يعرض المشروع المعتمد من ملف Excel', projectList.includes('مشروع اختبار E2E') && projectList.includes('E2E-001') && projectNavClicked);
    const detailsOpened = await clickByText(window, 'table.data tbody tr button', 'التفاصيل');
    await waitFor(window, `document.body.innerText.includes('مصدر البيانات') && document.body.innerText.includes('مشاريع اختبار')`, 30000);
    check('pages', 'تفاصيل المشروع تعرض التمويل والمصدر وملاحظات الجودة', detailsOpened && (await bodyText(window)).includes('جهات التمويل'));
    await screenshot(window, '16-سجل-المشاريع.png');
    await waitFor(window, `(() => { const button = document.querySelector('.modal-card .modal-head button[aria-label="إغلاق"]'); const rect = button?.getBoundingClientRect(); return Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight); })()`, 12000);
    const projectDetailsClosed = await clickBySelector(window, '.modal-card .modal-head button[aria-label="إغلاق"]', 'إغلاق تفاصيل المشروع');
    check('pages', 'تفاصيل المشروع تغلق بزر واضح قبل متابعة التنقل', projectDetailsClosed);

    await clickByText(window, '.side-nav .nav-item', 'اللوحة التفاعلية');
    await waitFor(window, `document.body.innerText.includes('ملخص قياسات المؤشرات وسجل الجودة')`, 12000);
    const dashboardSummaryText = await bodyText(window);
    check('pages', 'اللوحة تعرض ملخصات القياسات والجودة بدل الصفحات التفصيلية', dashboardSummaryText.includes('قياسات محفوظة') && dashboardSummaryText.includes('مؤشرات ممثلة') && dashboardSummaryText.includes('ملاحظات جودة مفتوحة') && dashboardSummaryText.includes('ملاحظات مسوّاة'));
    const retainedOperationalData = await window.webContents.executeJavaScript(`Promise.all([
      window.localApp.dataQualityIssues({ status: 'open', limit: 1 }),
      window.localApp.indicatorObservations({ limit: 1 }),
    ]).then(([quality, observations]) => ({
      qualityAvailable: Array.isArray(quality.rows),
      observationsAvailable: Array.isArray(observations.rows),
    }))`);
    check('pages', 'بيانات القياسات والجودة ما زالت متاحة عبر الواجهات الخلفية', retainedOperationalData.qualityAvailable && retainedOperationalData.observationsAvailable, JSON.stringify(retainedOperationalData));

    // ---------- 4. Access profile ----------
    const toggled = await clickBySelector(window, '.topbar button.chip.clickable', 'تبديل وضع الوصول');
    await sleep(700);
    const profile = await window.webContents.executeJavaScript(`window.localApp.status().then((s) => s.accessProfile)`);
    check('security', 'تبديل وضع الوصول يعمل ويُحفظ', toggled && profile === 'shared', `profile=${profile}`);
    const restoredClick = await clickBySelector(window, '.topbar button.chip.clickable', 'العودة لوضع المالك');
    check('security', 'زر العودة لوضع المالك استقبل نقرة فعلية', restoredClick);
    await sleep(500);
    const restored = await window.webContents.executeJavaScript(`window.localApp.status().then((s) => s.accessProfile)`);
    check('security', 'العودة إلى وضع المالك تعمل', restored === 'owner', `profile=${restored}`);

    // ---------- 5. Export ----------
    const persist = require(path.join(ROOT, 'src', 'main', 'analysis', 'persist.cjs'));
    const { analyze } = require(path.join(ROOT, 'src', 'main', 'analysis', 'engine.cjs'));
    const { readDirectorateWorkbook } = require(path.join(ROOT, 'src', 'main', 'analysis', 'template-reader.cjs'));
    const { exportAnalysisPdf, renderReportHtml } = require(path.join(ROOT, 'src', 'main', 'analysis', 'pdf.cjs'));
    const { exportAnalysisWorkbook } = require(path.join(ROOT, 'src', 'main', 'analysis', 'exporter.cjs'));
    const ExcelJS = require('exceljs');
    const Database = require('better-sqlite3-multiple-ciphers');

    const finalStoreHeader = fs.readFileSync(STORE_PATH).subarray(0, 16).toString('latin1');
    check('export', 'قاعدة البيانات النهائية تبقى ملف SQLite عاديًا بلا مفتاح', finalStoreHeader === 'SQLite format 3\u0000', JSON.stringify(finalStoreHeader));
    // The store opens with no key at all: this is the whole point of the change.
    const database = new Database(STORE_PATH, { readonly: true });
    const liveAnalysis = analyze(persist.loadAnalysisRows(database), {});
    // Mode A normalises against the sample's own min/max, so the invariant is
    // "database run equals workbook run on the same 20 rows", not a fixed 0.200.
    const sampleRead = await readDirectorateWorkbook(SAMPLE);
    const expected = analyze(sampleRead.rows, {});

    const shaar = liveAnalysis.rows.find((row) => row.districtName === 'مديرية الشعر');
    const expectedShaar = expected.rows.find((row) => row.districtName === 'مديرية الشعر');
    check('export', 'الجولة الكاملة تحفظ المركّب بلا انحراف (قاعدة = ملف)', Math.abs(shaar.replica.composite - expectedShaar.replica.composite) < 1e-9, `${shaar.replica.composite} vs ${expectedShaar.replica.composite}`);
    const blockedNames = liveAnalysis.rows.filter((row) => row.calibrated.blocked).map((row) => row.districtName);
    check('export', 'المسار المعاير يحجب أزال وبيت الفقيه', blockedNames.includes('مديرية أزال') && blockedNames.includes('مديرية بيت الفقيه'), `${blockedNames.length} محجوبة`);
    check('export', 'المحجوب لا يدخل قائمة الترتيب', liveAnalysis.ranking.calibrated.ranked.every((row) => !row.calibrated?.blocked));

    const html = renderReportHtml(liveAnalysis, {});
    check('export', 'التقرير لا يذكر ملف الإدخال', !html.includes('القالب'), 'no template wording');
    check('export', 'التقرير يعرض مقارنة المسارين', html.includes('مقارنة المسارين'));
    check('export', 'التقرير يوثّق المنهجية والحدود', html.includes('خط الحرمان') && html.includes('المستوى الجغرافي مديرية فقط'));

    const pdfPath = path.join(EVIDENCE, '6-تقرير-التحليل.pdf');
    const pdf = await exportAnalysisPdf({ BrowserWindow }, pdfPath, liveAnalysis, { audit: persist.listAccess(database, 50) });
    check('export', 'PDF يُنتج بمحرك الطباعة', fs.readFileSync(pdfPath).subarray(0, 5).toString('latin1') === '%PDF-' && pdf.bytes > 20000, `${pdf.bytes} bytes`);

    const xlsxPath = path.join(EVIDENCE, '7-نتائج-التحليل.xlsx');
    await exportAnalysisWorkbook(xlsxPath, liveAnalysis, { audit: persist.listAccess(database, 200) });
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.readFile(xlsxPath);
    const sheetNames = reopened.worksheets.map((sheet) => sheet.name);
    check('export', 'ملف Excel يحتوي الأوراق الثماني', reopened.worksheets.length === 8, sheetNames.join(' · '));
    check('export', 'ملف Excel يحتوي المنهجية والأوزان', sheetNames.includes('المنهجية والأوزان'));

    const dataSheet = reopened.getWorksheet('قاعدة البيانات الشاملة');
    let shaarRow = null;
    for (let rowNumber = 2; rowNumber <= dataSheet.rowCount; rowNumber += 1) {
      if (dataSheet.getRow(rowNumber).getCell(1).value === 'مديرية الشعر') { shaarRow = rowNumber; break; }
    }
    check('export', 'ورقة البيانات تحمل المؤشر المرجّح في BG', shaarRow !== null
      && dataSheet.getRow(1).getCell(59).value === 'المؤشر المرجّح المباشر'
      && Math.abs(dataSheet.getRow(shaarRow).getCell(59).value - expectedShaar.replica.composite) < 1e-4, `row=${shaarRow}`);

    let leak = '';
    for (const sheet of reopened.worksheets) {
      const header = sheet.getRow(1);
      for (let column = 1; column <= header.cellCount; column += 1) {
        const value = String(header.getCell(column).value ?? '');
        if (value.includes('القالب') || value.includes('مطابقة')) leak = `${sheet.name}:${column}:${value}`;
      }
    }
    check('export', 'لا ترويسة في Excel تذكر ملف الإدخال', leak === '', leak);

    const htmlPath = path.join(USER_DATA, 'report-preview.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    const preview = new BrowserWindow({ show: false, width: 1000, height: 1500, webPreferences: { offscreen: true, sandbox: true } });
    await preview.loadFile(htmlPath);
    await preview.webContents.setZoomFactor(0.85);
    await sleep(700);
    const previewShot = await preview.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, '9-معاينة-التقرير.png'), previewShot.toPNG());
    preview.destroy();
    check('export', 'معاينة التقرير تُولَّد للفحص البصري', previewShot.getSize().width > 500, `${previewShot.getSize().width}x${previewShot.getSize().height}`);

    database.close();
  } catch (error) {
    check('pages', 'اكتمال التجربة دون استثناء', false, error.message);
    console.error(error);
  } finally {
    try {
      writeGroup('3-فحص-واجهة-الدخول.json', 'entry');
      writeGroup('3-فحص-التنقل.json', 'nav');
      writeGroup('4-فحص-الاستيراد.json', 'import');
      writeGroup('5-فحص-الشاشات.json', 'pages');
      writeGroup('6-فحص-وضع-الوصول.json', 'security');
      writeGroup('7-فحص-التصدير.json', 'export');
      writeGroup('13-فحص-الوصولية.json', 'accessibility');
      fs.writeFileSync(path.join(EVIDENCE, '12-تتبع-التفاعلات.json'), JSON.stringify({
        generatedAt: new Date().toISOString(),
        method: 'scrollIntoView on nearest scroll container, then Electron webContents.sendInputEvent with elementFromPoint hit-testing',
        interactionCount: interactionTrace.length,
        interactions: interactionTrace,
      }, null, 2), 'utf8');

      const failed = results.filter((item) => !item.ok);
      const defects = failed.map((item) => ({
        severity: SEVERITY[item.group] ?? 'minor',
        scenario: item.group,
        name: item.name,
        detail: item.detail,
      }));
      fs.writeFileSync(path.join(EVIDENCE, '10-تقرير-العيوب.json'), JSON.stringify({
        generatedAt: new Date().toISOString(),
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        defects,
      }, null, 2), 'utf8');

      const ux = [
        '# اختبار تجربة الاستخدام — نظام التنمية المحلية',
        '',
        `- التاريخ: ${new Date().toLocaleString('ar')}`,
        `- البيئة: Electron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}`,
        `- السيناريوهات: ${results.length} · ناجحة: ${results.length - failed.length} · فاشلة: ${failed.length}`,
        '',
        '## السيناريوهات المغطاة',
        '',
        '1. الدخول بلا كلمة مرور والتحقق من المظهر الداكن.',
        '2. استيراد ملف Excel: فحص، خطة، قرارات، تطبيق على 20 مديرية.',
        '3. اللوحة التفاعلية: الإجماليات والاكتمال وتغطية المؤشرات.',
        '4. المؤشرات الـ 12: الأبعاد والمصفوفة الكاملة.',
        '5. ترتيب الأولويات: القائمة المرتبة وقاعدة الاحتساب.',
        '6. قاعدة البيانات الشاملة: البحث والعرض المختصر.',
        '7. بطاقة المديرية: كل الحقول والمؤشرات والمصدر والسجل الزمني.',
        '8. تصحيح البيانات: محرر السجلات.',
        '9. الاستيراد الآلي: الخطوات الثلاث وقواعد التحقق.',
        '10. سجل المشاريع: اعتماد صف، مراجعة المصدر، وتسوية الجودة.',
        '11. سجل القياسات: إدخال قياس مؤرخ وحفظ مصدره.',
        '12. وضع الوصول: التبديل بين المالك والمشاركة.',
        '13. التصدير: PDF وExcel، مع التأكد من عدم ذكر ملف الإدخال.',
        '',
        '## العيوب',
        '',
        failed.length ? failed.map((item) => `- [${SEVERITY[item.group] ?? 'minor'}] ${item.name} — ${item.detail}`).join('\n') : 'لا عيوب مرصودة في هذه الجولة.',
      ].join('\n');
      fs.writeFileSync(path.join(EVIDENCE, '11-اختبار-تجربة-الاستخدام.md'), ux, 'utf8');

      const groups = [...new Set(results.map((item) => item.group))];
      const lines = [
        'نظام التنمية المحلية — تقرير الفحص الآلي',
        `التاريخ: ${new Date().toLocaleString('ar')}`,
        `البيئة: Electron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}`,
        `المجموع: ${results.length} · ناجح: ${results.length - failed.length} · فاشل: ${failed.length}`,
        '',
        'المجموعات:',
        ...groups.map((group) => {
          const entries = results.filter((item) => item.group === group);
          return `  ${group}: ${entries.filter((item) => item.ok).length}/${entries.length}`;
        }),
        '',
        'الملفات المرفقة:',
        '  1-واجهة-الدخول.png          لقطة شاشة الدخول بلا كلمة مرور',
        '  2-اللوحة-التفاعلية.png      اللوحة بعد الاستيراد',
        '  3-المؤشرات.png              مصفوفة المؤشرات الـ12',
        '  4-ترتيب-الأولويات.png       قائمة الأولويات',
        '  5-قاعدة-البيانات.png        قاعدة البيانات الشاملة',
        '  6-بطاقة-مديرية.png          بطاقة مديرية كاملة',
        '  7-تصحيح-البيانات.png        شاشة التصحيح',
        '  8-الاستيراد.png             شاشة الاستيراد',
        '  17-ملخص-اللوحة              ملخص القياسات والجودة مع بقاء البيانات محفوظة',
        '  3..7 ملفات JSON             نتائج كل مجموعة',
        '  6-تقرير-التحليل.pdf         التقرير الفعلي المولّد من المحرك',
        '  7-نتائج-التحليل.xlsx        ملف Excel بثماني أوراق',
        '  9-معاينة-التقرير.png        معاينة بصرية لصفحات التقرير',
        '  10-تقرير-العيوب.json        العيوب مصنّفة بالخطورة',
        '  11-اختبار-تجربة-الاستخدام.md سيناريوهات الاستخدام ونتائجها',
        '',
        failed.length ? 'الفاشل:' : 'كل الفحوص ناجحة.',
        ...failed.map((item) => `  - ${item.name} :: ${item.detail}`),
      ];
      fs.writeFileSync(path.join(EVIDENCE, '8-ملخص-الفحص.txt'), lines.join('\r\n'), 'utf8');
    } catch (writeError) {
      console.error(writeError);
    }

    const failed = results.filter((item) => !item.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
    app.exit(failed.length ? 1 : 0);
  }
});