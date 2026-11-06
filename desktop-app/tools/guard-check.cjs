/*
 * Guard check: a packaged build must ignore --dev-server and keep loading local files.
 * Usage: node tools/guard-check.cjs "<packaged exe>"
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const exe = process.argv[2];
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, '--dev-server=https://example.com/'], {
    stdio: 'ignore',
  });
  const out = { passed: false };
  try {
    let target;
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch {
        /* not ready */
      }
      if (!target) await sleep(500);
    }
    if (!target) throw new Error('no devtools target');
    out.url = target.url;
    out.title = target.title;
    out.remoteHostUsed = /example\.com/.test(target.url);
    out.localFile = target.url.startsWith('file://');
    out.passed = out.localFile && !out.remoteHostUsed;
  } catch (error) {
    out.error = error.message;
  } finally {
    child.kill();
    fs.writeFileSync(path.join(__dirname, '..', 'guard-result.json'), JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify(out, null, 2));
  }
})();
