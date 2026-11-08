'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const harness = fs.readFileSync(path.join(root, 'scripts/e2e-analysis.cjs'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main/main.cjs'), 'utf8');
const offlinePolicy = fs.readFileSync(path.join(root, 'src/main/offline-policy.cjs'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(root, '../.github/workflows/release.yml'), 'utf8');

test('Electron E2E drives real pointer input and checks the true hit target', () => {
  assert.match(harness, /sendInputEvent\(\{ type: 'mouseMove'/);
  assert.match(harness, /sendInputEvent\(\{ type: 'mouseDown'/);
  assert.match(harness, /sendInputEvent\(\{ type: 'mouseUp'/);
  assert.match(harness, /document\.elementFromPoint/);
  assert.match(harness, /target\.contains\(hit\)/);
  assert.doesNotMatch(harness, /\.click\(\)/);
});

test('Electron E2E records before/after screenshots and per-action traces', () => {
  assert.match(harness, /click-traces/);
  assert.match(harness, /beforeFile/);
  assert.match(harness, /afterFile/);
  assert.match(harness, /12-تتبع-التفاعلات\.json/);
});

test('Electron E2E validates network guards and the update-only allowlist', () => {
  assert.match(main, /installOfflineNetworkGuards\(\{ electronNet: net, allowedNetworkRequest: isAllowedUpdateRequest \}\)/);
  assert.match(offlinePolicy, /automaticUpdatesEnabled: true/);
  assert.match(offlinePolicy, /function isAllowedUpdateRequest/);
  assert.match(offlinePolicy, /github\.com/);
  assert.match(main, /installOfflineSessionGuard\(session\.defaultSession\)/);
  assert.match(offlinePolicy, /webRequest\.onBeforeRequest/);
  assert.match(offlinePolicy, /http:\/\/\*\/\*/);
  assert.match(offlinePolicy, /https:\/\/\*\/\*/);
  assert.match(offlinePolicy, /ws:\/\/\*\/\*/);
  assert.match(offlinePolicy, /wss:\/\/\*\/\*/);
  assert.match(offlinePolicy, /callback\(\{ cancel: true \}\)/);
  assert.match(offlinePolicy, /recordBlockedAttempt\('renderer'/);
  assert.match(harness, /getOfflineNetworkAudit/);
  assert.match(harness, /networkAttemptCount === 0/);
});

test('Electron E2E opens the native file dialog path and verifies the workbook inventory UI', () => {
  assert.match(harness, /dialog\.showOpenDialog = async/);
  assert.match(harness, /اختيار ملف Excel/);
  assert.match(harness, /فحص بنية ملف Excel/);
  assert.match(harness, /inventoryUi\.sheetNames/);
  assert.match(harness, /inventoryUi\.visible/);
  assert.match(harness, /14-فهرس-الأوراق\.png/);
  assert.match(harness, /scrollIntoView\(\{ behavior: 'instant', block: 'start' \}\)/);
});

test('Electron E2E checks keyboard focus visibility', () => {
  assert.match(harness, /keyCode: 'TAB'/);
  assert.match(harness, /:focus-visible/);
});

test('Electron E2E verifies the new data review screens with real interactions', () => {
  assert.match(harness, /سجل قياسات المؤشرات/);
  assert.match(harness, /جودة البيانات/);
  assert.match(harness, /تسوية مع حفظ السبب/);
  assert.match(harness, /حفظ القياس/);
});

test('Windows release workflow builds the renderer before launching Electron E2E', () => {
  const tests = releaseWorkflow.indexOf('name: Run unit and integration tests');
  const build = releaseWorkflow.indexOf('name: Build renderer');
  const e2e = releaseWorkflow.indexOf('name: Run full Electron end-to-end checks');
  assert.ok(tests >= 0 && build > tests && e2e > build);
});
