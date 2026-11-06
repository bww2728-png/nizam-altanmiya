/*
 * End-to-end check of the packaged application through the Chrome DevTools Protocol.
 * Usage: node tools/e2e.cjs "<path to packaged exe>"
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error('exe not found:', exe);
  process.exit(2);
}

const PORT = 9331;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
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
    ws.onerror = (event) => reject(new Error('ws error ' + event.message));
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

const fillAndSubmit = `
(() => {
  const button = document.querySelector('.welcome-screen .primary-button');
  if (!button) return { ok: false, reason: 'welcome button missing' };
  button.click();
  return { ok: true };
})()
`;

(async () => {
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', detached: false });
  let result = { passed: false };
  try {
    const target = await waitForTarget();
    const cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    let before = { result: { value: 'other' } };
    for (let i = 0; i < 40; i++) {
      before = await cdp.send('Runtime.evaluate', {
        expression: 'document.querySelector(".welcome-screen") ? "lock" : "other"',
        returnByValue: true,
      });
      if (before.result.value === 'lock') break;
      await sleep(500);
    }
    result.initialScreen = before.result.value;
    const submit = await cdp.send('Runtime.evaluate', { expression: fillAndSubmit, returnByValue: true });
    result.submit = submit.result.value;
    await sleep(4000);
    const after = await cdp.send('Runtime.evaluate', {
      expression: `({ lock: !!document.querySelector('.welcome-screen'), nav: document.querySelectorAll('.nav-item').length, text: document.body.innerText.slice(0, 120) })`,
      returnByValue: true,
    });
    result.afterUnlock = after.result.value;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'screenshot-dashboard.png'), Buffer.from(shot.data, 'base64'));
    result.passed = result.initialScreen === 'lock' && result.afterUnlock.lock === false && result.afterUnlock.nav > 0;
    cdp.close();
  } catch (error) {
    result.error = error.message;
  } finally {
    child.kill();
    fs.writeFileSync(path.join(__dirname, '..', 'e2e-result.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  }
})();
