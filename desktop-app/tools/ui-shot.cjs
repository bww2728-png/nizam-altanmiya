/*
 * UI preview / smoke check for the source build through the Chrome DevTools Protocol.
 * Usage: node tools/ui-shot.cjs "<path to electron.exe>" "<app directory>"
 * Captures the welcome screen and the dashboard, and fails when the branded
 * elements or the password-free entry flow are missing.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const exe = process.argv[2];
const appDir = process.argv[3] || path.join(__dirname, '..');
if (!exe || !fs.existsSync(exe)) {
  console.error('electron binary not found:', exe);
  process.exit(2);
}

const PORT = 9335;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('devtools target not found');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('websocket error'));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

async function evaluate(cdp, expression, timeoutMs = 30000) {
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(`timeout: ${expression.slice(0, 60)}`)), timeoutMs)),
  ]);
  return result.result ? result.result.value : undefined;
}

async function screenshot(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

(async () => {
  const child = spawn(exe, [appDir, `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  const report = { passed: false };
  let cdp;
  try {
    const target = await waitForTarget();
    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    for (let i = 0; i < 40; i++) {
      if (await evaluate(cdp, `!!document.querySelector('.welcome-screen')`)) break;
      await sleep(400);
    }
    report.welcome = await evaluate(
      cdp,
      `({
        banner: !!document.querySelector('.welcome-banner'),
        badge: !!document.querySelector('.welcome-loading img') || !!document.querySelector('.welcome-card img'),
        taglines: document.querySelectorAll('.welcome-taglines li').length,
        subtitle: (document.querySelector('.welcome-subtitle') || {}).textContent || '',
        passwordFields: document.querySelectorAll('input[type=password]').length,
        button: (document.querySelector('.welcome-screen .primary-button') || {}).textContent || ''
      })`
    );
    await screenshot(cdp, path.join(appDir, 'screenshot-welcome.png'));

    await evaluate(cdp, `document.querySelector('.welcome-screen .primary-button').click()`);
    for (let i = 0; i < 40; i++) {
      if (await evaluate(cdp, `document.querySelectorAll('.nav-item').length > 0`)) break;
      await sleep(400);
    }
    report.dashboard = await evaluate(
      cdp,
      `({
        nav: document.querySelectorAll('.nav-item').length,
        heroBanner: !!document.querySelector('.hero'),
        sidebarLogo: !!document.querySelector('.brand-icon img'),
        error: (document.querySelector('.error-banner') || {}).textContent || ''
      })`
    );
    await screenshot(cdp, path.join(appDir, 'screenshot-dashboard.png'));

    report.passed =
      report.welcome.banner === true &&
      report.welcome.taglines === 4 &&
      report.welcome.passwordFields === 0 &&
      report.dashboard.nav === 4 &&
      report.dashboard.heroBanner === true &&
      report.dashboard.sidebarLogo === true &&
      !report.dashboard.error;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (cdp) cdp.close();
    child.kill();
    fs.writeFileSync(path.join(appDir, 'ui-shot-result.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  }
})();
