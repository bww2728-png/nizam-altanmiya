/*
 * Full round trip against the packaged app: unlock -> scan a real workbook ->
 * build the import plan -> decide rows -> apply -> read the three sheet views ->
 * export to Excel -> verify the file.
 * Usage: node tools/import-e2e.cjs "<exe>" "<source xlsx>"
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const exe = process.argv[2];
const source = process.argv[3];
const appArgs = (process.argv[4] || '').split('|').filter(Boolean);
const PORT = 9343;
const workDir = 'C:\\dev\\_cache\\import-test';
const logFile = path.join(__dirname, '..', 'import-e2e-log.txt');
const resultFile = path.join(__dirname, '..', 'import-e2e-result.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...parts) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${parts.join(' ')}\n`);

function submitDialog(pid, text) {
  const script = path.join(__dirname, 'dialog-fill.ps1');
  const started = Date.now();
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessId', String(pid), '-Path', text, '-TimeoutSeconds', '25'],
    { encoding: 'utf8', timeout: 60000 }
  );
  const out = (result.stdout || '').trim();
  log(`dialog(${path.basename(text)}) ${out} in ${Date.now() - started}ms`);
  return out;
}

async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws failed'));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  };
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function evalJs(cdp, expression, { awaitPromise = false, timeoutMs = 30000 } = {}) {
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }),
    sleep(timeoutMs).then(() => {
      throw new Error('evaluate timeout: ' + expression.slice(0, 70));
    }),
  ]);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed');
  return result.result.value;
}

(async () => {
  fs.writeFileSync(logFile, '');
  fs.mkdirSync(workDir, { recursive: true });
  const inputPath = path.join(workDir, 'data.xlsx');
  const exportPath = path.join(workDir, 'export.xlsx');
  fs.copyFileSync(source, inputPath);
  fs.rmSync(exportPath, { force: true });

  const report = { input: inputPath, source, exportPath, steps: [] };
  const child = spawn(exe, [...appArgs, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  log('spawned pid=' + child.pid);

  let cdp;
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch {
        /* starting */
      }
      if (!target) await sleep(500);
    }
    if (!target) throw new Error('devtools target missing');
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      ready = await evalJs(cdp, '!!document.querySelector(".welcome-screen")');
      if (!ready) await sleep(400);
    }
    report.lockScreen = ready;

    report.statusBefore = await evalJs(cdp, 'window.localApp.status()', { awaitPromise: true });
    report.open = await evalJs(cdp, 'window.localApp.open()', { awaitPromise: true, timeoutMs: 30000 });
    log('open ' + JSON.stringify(report.open));

    // The scan channel opens the native dialog only when no path is supplied, so
    // the script hands the copied workbook over directly and reads back the plan.
    report.scan = await evalJs(cdp, `window.localApp.scanWorkbook({ filePath: ${JSON.stringify(inputPath)} })`, {
      awaitPromise: true,
      timeoutMs: 240000,
    });
    if (report.scan?.canceled) throw new Error('scan canceled');
    log('scan ' + JSON.stringify({ totalRows: report.scan.totalRows, scope: report.scan.scope }));

    report.plan = await evalJs(cdp, 'window.localApp.importPlan()', { awaitPromise: true, timeoutMs: 120000 });
    report.planSample = (report.plan.preview ?? []).slice(0, 3).map((row) => ({
      rowNumber: row.rowNumber,
      district: row.districtName,
      action: row.action,
      status: row.status,
      issues: row.issues.map((issue) => issue.code),
    }));
    log('plan ' + JSON.stringify({ totalRows: report.plan.totalRows, scope: report.plan.scope }));

    // Per-row decisions: blocked rows are skipped unless the run deliberately
    // forces them, which is what the import-plan screen lets the operator do.
    const decisions = {};
    for (const row of report.plan.preview ?? []) {
      decisions[row.rowNumber] = row.status === 'blocked' ? 'skip' : 'apply';
    }
    report.decisions = {
      rows: Object.keys(decisions).length,
      skipped: Object.values(decisions).filter((decision) => decision === 'skip').length,
    };

    report.apply = await evalJs(
      cdp,
      `window.localApp.applyImport(${JSON.stringify({ decisions, force: false })})`,
      { awaitPromise: true, timeoutMs: 240000 }
    );
    log(
      'apply ' +
        JSON.stringify({
          created: report.apply.created,
          updated: report.apply.updated,
          refused: report.apply.refused?.length ?? 0,
          skipped: report.apply.skipped?.length ?? 0,
        })
    );

    report.dashboard = await evalJs(cdp, 'window.localApp.sheetDashboard()', { awaitPromise: true });
    report.dashboardTotals = report.dashboard.totals;
    report.indicators = await evalJs(cdp, 'window.localApp.sheetIndicators()', { awaitPromise: true });
    report.indicatorRows = report.indicators.rows.length;
    report.ranking = await evalJs(cdp, "window.localApp.sheetRanking({ mode: 'calibrated' })", { awaitPromise: true });
    report.rankingCounts = { ranked: report.ranking.ranked.length, ...report.ranking.excluded };

    report.run = await evalJs(cdp, 'window.localApp.runAnalysis({})', { awaitPromise: true, timeoutMs: 240000 });
    report.runId = report.run?.runId ?? null;

    const exportPromise = evalJs(cdp, 'window.localApp.exportAnalysisExcel()', { awaitPromise: true, timeoutMs: 120000 });
    await sleep(1500);
    submitDialog(child.pid, exportPath);
    report.export = await exportPromise;
    log('export ' + JSON.stringify(report.export));

    const exportedFile = report.export?.filePath || exportPath;
    report.exportedFile = exportedFile;

    report.nav = await evalJs(
      cdp,
      `(() => {
        const wanted = ['ترتيب الأولويات', 'الأولويات', 'الترتيب'];
        const item = [...document.querySelectorAll('.nav-item')].find((node) => wanted.some((label) => (node.textContent || '').includes(label)));
        if (item) item.click();
        return Boolean(item);
      })()`
    );
    await sleep(1200);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'screenshot-sheets.png'), Buffer.from(shot.data, 'base64'));

    if (fs.existsSync(exportedFile)) {
      const ExcelJS = require(path.join(__dirname, '..', 'node_modules', 'exceljs'));
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(exportedFile);
      const sheet = workbook.worksheets[0];
      report.exportedRows = Math.max(0, sheet.actualRowCount - 1);
      report.exportedHeader = sheet.getRow(1).values.slice(1, 8);
      report.exportedFirstRow = sheet.actualRowCount > 1 ? sheet.getRow(2).values.slice(1, 8) : null;
    }
    report.passed =
      report.open?.success === true &&
      report.scan?.totalRows > 0 &&
      report.plan?.totalRows > 0 &&
      report.apply?.applied >= 1 &&
      report.dashboardTotals?.directorates >= 1 &&
      report.exportedRows >= 1;
  } catch (error) {
    report.error = error.message;
    log('ERROR ' + error.message);
  } finally {
    try {
      if (cdp) cdp.close();
    } catch {
      /* ignore */
    }
    child.kill();
    fs.writeFileSync(resultFile, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    await sleep(800);
    process.exit(report.passed ? 0 : 1);
  }
})();
