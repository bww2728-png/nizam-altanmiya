'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { OFFLINE_RUNTIME_POLICY, offlineUpdateStatus } = require('../src/main/offline-policy.cjs');

const ROOT = path.join(__dirname, '..');

test('runtime policy explicitly forbids network, cloud AI, local AI models and automatic updates', () => {
  assert.deepEqual(OFFLINE_RUNTIME_POLICY, {
    mode: 'offline-only',
    networkAllowed: false,
    cloudAiAllowed: false,
    localAiModelIncluded: false,
    automaticUpdatesEnabled: false,
    updateDistribution: 'local-installer-package',
  });
});

test('update status describes local package distribution without initiating an update', () => {
  assert.deepEqual(offlineUpdateStatus('0.5.2'), {
    state: 'offline-only',
    currentVersion: '0.5.2',
    message: 'يعمل النظام محليًا دون اتصال بالإنترنت. تُثبَّت التحديثات من حزمة محلية معتمدة.',
    updateDistribution: 'local-installer-package',
  });
});

test('packaged main process contains no automatic updater bootstrap or remote update call', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/main/main.cjs'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]electron-updater['"]\)/);
  assert.doesNotMatch(source, /checkForUpdates\s*\(/);
  assert.doesNotMatch(source, /setupAutoUpdate\s*\(/);
  assert.match(source, /ipcMain\.handle\('update:check', async \(\) => offlineUpdateStatus/);
  assert.match(source, /ipcMain\.handle\('update:install', \(\) => false\)/);
});

test('renderer exposes the offline-only update status as an informational state', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/App.jsx'), 'utf8');
  assert.match(source, /'offline-only'/);
  assert.match(source, /دون اتصال بالإنترنت/);
  assert.match(source, /حزمة محلية معتمدة/);
});
