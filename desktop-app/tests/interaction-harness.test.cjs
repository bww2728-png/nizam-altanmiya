'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const harness = fs.readFileSync(path.join(root, 'scripts/e2e-analysis.cjs'), 'utf8');

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

test('Electron E2E blocks and reports Chromium HTTP, HTTPS and WebSocket requests', () => {
  assert.match(harness, /webRequest\.onBeforeRequest/);
  assert.match(harness, /http:\/\/\*\/\*/);
  assert.match(harness, /https:\/\/\*\/\*/);
  assert.match(harness, /ws:\/\/\*\/\*/);
  assert.match(harness, /wss:\/\/\*\/\*/);
  assert.match(harness, /callback\(\{ cancel: true \}\)/);
  assert.match(harness, /networkAttempts\.length === 0/);
});

test('Electron E2E opens the native file dialog path and verifies the workbook inventory UI', () => {
  assert.match(harness, /dialog\.showOpenDialog = async/);
  assert.match(harness, /اختيار ملف القالب/);
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
