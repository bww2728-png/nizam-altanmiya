'use strict';

/**
 * End-to-end verification of the real application.
 *
 * Run with:  npx electron scripts/e2e-analysis.cjs
 *
 * Boots the production renderer against a throwaway user-data directory,
 * imports the reference template, drives the analysis screen through the DOM,
 * writes a real PDF and a real workbook, and stores every artefact plus a
 * machine-readable transcript in «نتائج-الفحص».
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'template-v3.3.xlsx');
const EVIDENCE = path.join(ROOT, '..', 'نتائج-الفحص');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-e2e-'));

app.setPath('userData', USER_DATA);
require(path.join(ROOT, 'src', 'main', 'main.cjs'));

const results = [];
function check(group, name, condition, detail = '') {
  results.push({ group, name, ok: Boolean(condition), detail });
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForWindow(timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length) return windows[0];
    await sleep(120);
  }
  throw new Error('main window never appeared');
}

async function waitFor(window, expression, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await window.webContents.executeJavaScript(expression).catch(() => false);
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${expression}`);
}

async function clickByText(window, selector, text) {
  return window.webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const target = nodes.find((node) => (node.textContent || '').includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

async function clickRowAction(window, district, action) {
  return window.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.analysis-table tbody tr')]
      .find((node) => (node.textContent || '').includes(${JSON.stringify(district)}));
    if (!row) return false;
    const button = [...row.querySelectorAll('button')]
      .find((node) => (node.textContent || '').includes(${JSON.stringify(action)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function setFieldByLabel(window, label, value) {
  return window.webContents.executeJavaScript(`(() => {
    const field = [...document.querySelectorAll('.entry-field')]
      .find((node) => (node.querySelector('span')?.textContent || '').includes(${JSON.stringify(label)}));
    if (!field) return false;
    const control = field.querySelector('input, select');
    if (!control) return false;
    const proto = control.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(control, ${JSON.stringify(value)});
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function screenshot(window, fileName) {
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(EVIDENCE, fileName), image.toPNG());
  return image.getSize();
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

app.whenReady().then(async () => {
  let window;
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });

    window = await waitForWindow();
    await waitFor(window, `Boolean(document.querySelector('.welcome-card'))`);
    await sleep(400);

    // ---------- 1. Entry ----------
    const welcomeText = await window.webContents.executeJavaScript(`document.querySelector('.welcome-card').innerText`);
    check('entry', 'شاشة الدخول تُعرض بلا كلمة مرور', welcomeText.includes('نظام التنمية المحلية') && !welcomeText.includes('كلمة المرور'), welcomeText.slice(0, 50));
    check('entry', 'لا يوجد أي حقل كلمة مرور في الواجهة', await window.webContents.executeJavaScript(`document.querySelectorAll('input[type=password]').length === 0`));
    check('entry', 'صورة الهوية تظهر كخلفية للتطبيق', await window.webContents.executeJavaScript(`getComputedStyle(document.body).backgroundImage.includes('app-background')`));
    await screenshot(window, '1-واجهة-الدخول.png');

    const entered = await clickByText(window, 'button', 'الدخول إلى مساحة العمل')
      || await clickByText(window, 'button', 'إنشاء قاعدة البيانات والدخول');
    check('entry', 'زر الدخول يعمل', entered);
    await waitFor(window, `Boolean(document.querySelector('.sidebar'))`);

    const navLabels = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.nav-item span')].map((node) => node.textContent)`);
    check('entry', 'قسم تحليل الأولويات موجود في التنقل', navLabels.includes('تحليل الأولويات'), navLabels.join(' · '));
    check('entry', 'قاعدة البيانات تُفتح وتصبح مشفّرة', await window.webContents.executeJavaScript(`window.localApp.status().then((s) => s.unlocked && s.hasKey)`));

    // ---------- 2. Import ----------
    const imported = await window.webContents.executeJavaScript(`(async () => {
      const read = await window.localApp.readTemplate({ filePath: ${JSON.stringify(FIXTURE)} });
      const committed = await window.localApp.commitTemplate();
      return { totalRows: read.totalRows, sheet: read.sheetName, created: committed.created, total: committed.total, headerRow: read.headerRow, matched: read.matchedCount };
    })()`);
    check('import', 'قراءة القالب تكتشف الورقة والرأس المزدوج', imported.sheet === 'قاعدة البيانات الشاملة' && imported.headerRow === 2, JSON.stringify(imported));
    check('import', 'كل أعمدة الإدخال الـ39 مطابقة', imported.matched >= 39, `matched=${imported.matched}`);
    check('import', 'حفظ المديريات في القاعدة المشفّرة', imported.created === 3 && imported.total === 3, JSON.stringify(imported));

    // ---------- 3. Analysis ----------
    await clickByText(window, '.nav-item', 'تحليل الأولويات');
    await waitFor(window, `Boolean(document.querySelector('.analysis-page'))`);
    check('analysis', 'الشاشة تبدأ بحالة فارغة إرشادية', await window.webContents.executeJavaScript(`Boolean(document.querySelector('.analysis-empty'))`));

    const ran = await clickByText(window, '.analysis-actions button', 'تشغيل التحليل');
    check('analysis', 'زر تشغيل التحليل يعمل', ran);
    await waitFor(window, `Boolean(document.querySelector('.analysis-metrics'))`, 30000);
    await sleep(400);

    const metrics = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.analysis-metric')].map((node) => node.innerText.replace(/\\n/g, '='))`);
    check('analysis', 'بطاقات الملخص تُعرض', metrics.length >= 6, metrics.join(' | '));

    const summary = await window.webContents.executeJavaScript(`(async () => { const run = await window.localApp.latestAnalysis(); return { rows: run.results.length, k: run.run.kThreshold, line: run.run.deprivationLine }; })()`);
    check('analysis', 'التشغيل محفوظ في القاعدة بالمعايرة الصحيحة', summary.rows === 3 && summary.k === 4 && summary.line === 0.6, JSON.stringify(summary));

    const tableText = await window.webContents.executeJavaScript(`document.querySelector('.analysis-table')?.innerText || ''`);
    const bodyText = await window.webContents.executeJavaScript(`document.body.innerText`);
    check('analysis', 'جدول الأولويات يعرض المديرية المؤهلة', tableText.includes('مديرية الشعر'));
    check('analysis', 'المديريات المحجوبة تُعرض منفصلة', bodyText.includes('مديرية بيت الفقيه') && bodyText.includes('محجوبة لقلة الأدلة'));
    check('analysis', 'المركب المعاير للشعر يطابق 0.415', /0\.415/.test(tableText), tableText.split('\n').slice(0, 6).join(' | '));

    await clickByText(window, '.mode-switch button', 'مطابقة القالب');
    await sleep(300);
    const replicaText = await window.webContents.executeJavaScript(`document.body.innerText`);
    check('analysis', 'وضع مطابقة القالب يضع غير المكتمل في قائمة الانتظار', replicaText.includes('بانتظار استكمال البيانات'));

    await clickByText(window, '.mode-switch button', 'المعايرة العلمية');
    await sleep(200);
    const detailClicked = await clickByText(window, '.analysis-table button', 'تفاصيل');
    await sleep(300);
    const detailText = await window.webContents.executeJavaScript(`document.querySelector('.district-detail')?.innerText || ''`);
    check('analysis', 'لوحة التفاصيل تعرض المؤشرات المحسوبة', detailClicked && detailText.includes('عجز المياه'), detailText.split('\n').slice(0, 3).join(' | '));

    const sensitivityText = await window.webContents.executeJavaScript(`document.querySelector('.sensitivity-block')?.innerText || ''`);
    check('analysis', 'حقول الحساسية مصنّفة داخل بطاقة المديرية', sensitivityText.includes('إيرادات المديرية') && sensitivityText.includes('مقيّد'), sensitivityText.replace(/\n/g, ' · '));

    const comparison = await window.webContents.executeJavaScript(`document.body.innerText.includes('مقارنة المسارين')`);
    check('analysis', 'مقارنة المسارين تُعرض', comparison);

    // ---------- 4. Tabs ----------
    await clickByText(window, '.analysis-tabs button', 'فجوات البيانات');
    await sleep(300);
    const gapText = await window.webContents.executeJavaScript(`document.querySelector('.gap-summary')?.innerText || ''`);
    check('tabs', 'تبويب الفجوات يعرض العدادات', gapText.includes('مانع') && gapText.includes('تحذير'), gapText.replace(/\n/g, ' '));

    await clickByText(window, '.analysis-tabs button', 'الحساسية');
    await sleep(300);
    check('tabs', 'تبويب الحساسية يعرض سيناريوهات الأوزان والعيّنة', await window.webContents.executeJavaScript(`Boolean(document.querySelector('.sample-bars'))`));

    await clickByText(window, '.analysis-tabs button', 'الأوزان والمعايرة');
    await waitFor(window, `document.querySelectorAll('.weight-field').length === 12`, 10000);
    check('tabs', 'محرر الأوزان يعرض الاثني عشر مؤشرًا', true);
    const sumValid = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.weights-footer .primary-button')].every((node) => !node.disabled)`);
    check('tabs', 'الأوزان الافتراضية صالحة (المجموع = 1)', sumValid);

    await clickByText(window, '.analysis-tabs button', 'سجل التدقيق');
    await sleep(500);
    const auditText = await window.webContents.executeJavaScript(`document.querySelector('.analysis-table')?.innerText || ''`);
    check('tabs', 'سجل التدقيق يحتوي الاستيراد والتشغيل', auditText.includes('import') && auditText.includes('analysis-run'));

    await clickByText(window, '.analysis-tabs button', 'الأولويات');
    await sleep(400);
    const size = await screenshot(window, '2-شاشة-التحليل.png');
    check('tabs', 'لقطة شاشة الشاشة التحليلية', size.width > 1000, `${size.width}x${size.height}`);

    // ---------- 5. Export ----------
    const persist = require(path.join(ROOT, 'src', 'main', 'analysis', 'persist.cjs'));
    const { analyze } = require(path.join(ROOT, 'src', 'main', 'analysis', 'engine.cjs'));
    const { exportAnalysisPdf } = require(path.join(ROOT, 'src', 'main', 'analysis', 'pdf.cjs'));
    const { exportAnalysisWorkbook } = require(path.join(ROOT, 'src', 'main', 'analysis', 'exporter.cjs'));
    const ExcelJS = require('exceljs');
    const Database = require('better-sqlite3-multiple-ciphers');

    const database = new Database(path.join(USER_DATA, 'development-data.db'));
    database.pragma("cipher = 'sqlcipher'");
    const key = fs.readFileSync(path.join(USER_DATA, 'store.key'), 'utf8').trim();
    database.pragma(`key = '${key}'`);
    const liveAnalysis = analyze(persist.loadAnalysisRows(database), {});

    const shaar = liveAnalysis.rows.find((row) => row.districtName === 'مديرية الشعر');
    check('export', 'التكافؤ الرقمي مع القالب (AZ = 0.200)', Math.abs(shaar.replica.composite - 0.2) < 1e-12, String(shaar.replica.composite));
    check('export', 'المعايرة تحجب أزال وبيت الفقيه', liveAnalysis.rows.filter((row) => row.calibrated.blocked).length === 2);

    const pdfPath = path.join(EVIDENCE, '6-تقرير-التحليل.pdf');
    const pdf = await exportAnalysisPdf({ BrowserWindow }, pdfPath, liveAnalysis, { audit: persist.listAccess(database, 50) });
    check('export', 'PDF يُنتج بمحرك الطباعة', fs.readFileSync(pdfPath).subarray(0, 5).toString('latin1') === '%PDF-' && pdf.bytes > 20000, `${pdf.bytes} bytes`);

    const xlsxPath = path.join(EVIDENCE, '7-نتائج-التحليل.xlsx');
    await exportAnalysisWorkbook(xlsxPath, liveAnalysis, { audit: persist.listAccess(database, 200) });
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.readFile(xlsxPath);
    check('export', 'ملف Excel يحتوي الأوراق الست', reopened.worksheets.length === 6, reopened.worksheets.map((sheet) => sheet.name).join(' · '));
    const templateSheet = reopened.getWorksheet('قاعدة البيانات الشاملة');
    let shaarRow = null;
    for (let rowNumber = 2; rowNumber <= templateSheet.rowCount; rowNumber += 1) {
      if (templateSheet.getRow(rowNumber).getCell(1).value === 'مديرية الشعر') { shaarRow = rowNumber; break; }
    }
    check('export', 'ورقة القالب تحتوي البيانات والمركب', shaarRow !== null
      && Math.abs(templateSheet.getRow(shaarRow).getCell(52).value - 0.2) < 1e-12, `row=${shaarRow}`);

    // Visual preview of the generated report (the PDF itself is not an image).
    const { renderReportHtml } = require(path.join(ROOT, 'src', 'main', 'analysis', 'pdf.cjs'));
    const htmlPath = path.join(USER_DATA, 'report-preview.html');
    fs.writeFileSync(htmlPath, renderReportHtml(liveAnalysis, {}), 'utf8');
    const preview = new BrowserWindow({ show: false, width: 1000, height: 1500, webPreferences: { offscreen: true, sandbox: true } });
    await preview.loadFile(htmlPath);
    await preview.webContents.setZoomFactor(0.85);
    await sleep(600);
    const previewShot = await preview.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, '9-معاينة-التقرير.png'), previewShot.toPNG());
    preview.destroy();
    check('export', 'معاينة التقرير تُولَّد للفحص البصري', previewShot.getSize().width > 500, `${previewShot.getSize().width}x${previewShot.getSize().height}`);

    // ---------- 6. Manual entry ----------
    await clickByText(window, '.nav-item', 'إدخال البيانات');
    await waitFor(window, `Boolean(document.querySelector('.data-entry-page'))`);
    await sleep(300);
    check('manual', 'صفحة الإدخال اليدوي تُعرض من التنقل', await window.webContents.executeJavaScript(`Boolean(document.querySelector('.data-entry-page .entry-actions'))`));
    check('manual', 'زر الإدخال بالـOCR متاح', await window.webContents.executeJavaScript(`[...document.querySelectorAll('.entry-actions button')].some((node) => node.textContent.includes('OCR'))`));

    const addClicked = await clickByText(window, '.entry-actions button', 'إضافة مديرية');
    await waitFor(window, `Boolean(document.querySelector('.entry-form-panel'))`);
    check('manual', 'نموذج الإضافة يعرض كل المجموعات', addClicked && await window.webContents.executeJavaScript(`document.querySelectorAll('.entry-group').length === 5`));

    const filledIdentity = await setFieldByLabel(window, 'اسم المديرية', 'مديرية إدخال آلي');
    const filledGovernorate = await setFieldByLabel(window, 'المحافظة', 'إب');
    const filledPopulation = await setFieldByLabel(window, 'عدد السكان', '12345');
    const savedManual = filledIdentity && filledGovernorate && filledPopulation
      ? await clickByText(window, '.entry-footer button', 'حفظ المديرية')
      : false;
    check('manual', 'تعبئة الحقول وحفظ مديرية جديدة', savedManual);
    await waitFor(window, `!document.querySelector('.entry-form-panel')`, 10000);
    await sleep(400);

    const createdState = await window.webContents.executeJavaScript(`(async () => {
      const list = await window.localApp.directorates({ search: 'مديرية إدخال آلي', limit: 10 });
      return { total: list.total, row: list.rows[0] ?? null };
    })()`);
    check('manual', 'المديرية الجديدة تُحفظ في القاعدة', createdState.total === 4 && createdState.row?.district === 'مديرية إدخال آلي', JSON.stringify(createdState.row));
    check('manual', 'القيمة الرقمية تُخزَّن كرقم', createdState.row?.population === 12345, String(createdState.row?.population));
    check('manual', 'المصدر يُسجَّل كإدخال يدوي', createdState.row?.source_file === 'إدخال يدوي', createdState.row?.source_file);

    const editClicked = await clickRowAction(window, 'مديرية إدخال آلي', 'تعديل');
    await waitFor(window, `Boolean(document.querySelector('.entry-form-panel'))`);
    await sleep(200);
    const changed = editClicked ? await setFieldByLabel(window, 'عدد السكان', '54321') : false;
    const editSaved = changed ? await clickByText(window, '.entry-footer button', 'حفظ المديرية') : false;
    await waitFor(window, `!document.querySelector('.entry-form-panel')`, 10000);
    await sleep(300);
    const editedState = await window.webContents.executeJavaScript(`(async () => {
      const list = await window.localApp.directorates({ search: 'مديرية إدخال آلي', limit: 10 });
      return list.rows[0] ?? null;
    })()`);
    check('manual', 'تعديل مديرية قائمة يحدّث القيمة', editSaved && editedState?.population === 54321, String(editedState?.population));

    await window.webContents.executeJavaScript(`(() => { window.confirm = () => true; return true; })()`);
    const deleteClicked = await clickRowAction(window, 'مديرية إدخال آلي', 'حذف');
    await sleep(800);
    const finalState = await window.webContents.executeJavaScript(`(async () => {
      const list = await window.localApp.directorates({ limit: 10 });
      return { total: list.total, names: list.rows.map((row) => row.district) };
    })()`);
    check('manual', 'حذف المديرية يعيد العدد إلى ثلاثة', deleteClicked && finalState.total === 3 && !finalState.names.includes('مديرية إدخال آلي'), JSON.stringify(finalState));

    database.close();
  } catch (error) {
    check('analysis', 'اكتمال التجربة دون استثناء', false, error.message);
    console.error(error);
  } finally {
    try {
      writeGroup('3-فحص-واجهة-الدخول-والتنقل.json', 'entry');
      writeGroup('4-فحص-التحليل-والترتيب.json', 'analysis');
      writeGroup('5-فحص-الفجوات-والحساسية-والأوزان.json', 'tabs');
      writeGroup('6-فحص-استيراد-القالب.json', 'import');
      writeGroup('7-فحص-التصدير.json', 'export');
      writeGroup('8-فحص-الإدخال-اليدوي.json', 'manual');

      const failed = results.filter((item) => !item.ok);
      const lines = [
        'نظام التنمية المحلية — تقرير الفحص الآلي',
        `التاريخ: ${new Date().toLocaleString('ar')}`,
        `البيئة: Electron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}`,
        `المجموع: ${results.length} · ناجح: ${results.length - failed.length} · فاشل: ${failed.length}`,
        '',
        'الملفات المرفقة:',
        '  1-واجهة-الدخول.png        لقطة شاشة الدخول بلا كلمة مرور',
        '  2-شاشة-التحليل.png        لقطة شاشة شاشة التحليل بعد التشغيل',
        '  3..8  ملفات JSON           نتائج كل مجموعة فحص مع التفاصيل',
        '  8-فحص-الإدخال-اليدوي.json فحص الإضافة والتعديل والحذف',
        '  6-تقرير-التحليل.pdf        التقرير الفعلي المولّد من المحرك',
        '  7-نتائج-التحليل.xlsx       ملف Excel بست أوراق',
        '  9-معاينة-التقرير.png       معاينة بصرية لصفحات التقرير',
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