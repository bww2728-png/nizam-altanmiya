'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { OFFLINE_RUNTIME_POLICY, offlineUpdateStatus, installOfflineNetworkGuards, installOfflineSessionGuard, getOfflineNetworkAudit, clearOfflineNetworkAudit } = require('../src/main/offline-policy.cjs');

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
  assert.match(source, /installOfflineNetworkGuards\(\{ electronNet: net \}\)/);
  assert.match(source, /installOfflineSessionGuard\(session\.defaultSession\)/);
});


test('Node and Electron network APIs are blocked and recorded by the runtime guard', async () => {
  clearOfflineNetworkAudit();
  const modules = {
    http: { request() {}, get() {} },
    https: { request() {}, get() {} },
    net: { connect() {}, createConnection() {}, Socket: { prototype: { connect() {} } } },
    tls: { connect() {} },
    dns: { lookup() {}, resolve() {}, resolve4() {} },
    dgram: { createSocket() {} },
  };
  const globalObject = {
    fetch: async () => ({ ok: true }),
    WebSocket: class WebSocket {},
  };
  const electronNet = {
    request() { return 'request'; },
    fetch: async () => ({ ok: true }),
  };
  const guard = installOfflineNetworkGuards({ modules, globalObject, electronNet });
  try {
    for (const [api, call] of [
      ['http.request', () => modules.http.request('https://example.invalid')],
      ['https.request', () => modules.https.request('https://example.invalid')],
      ['net.connect', () => modules.net.connect(443, 'example.invalid')],
      ['net.Socket.connect', () => modules.net.Socket.prototype.connect()],
      ['tls.connect', () => modules.tls.connect(443, 'example.invalid')],
      ['dns.lookup', () => modules.dns.lookup('example.invalid')],
      ['dgram.createSocket', () => modules.dgram.createSocket('udp4')],
      ['electron.net.request', () => electronNet.request({ url: 'https://example.invalid' })],
    ]) {
      assert.throws(call, { code: 'ERR_OFFLINE_RUNTIME_BLOCKED' }, api + ' must be blocked');
    }
    await assert.rejects(globalObject.fetch('https://example.invalid'), { code: 'ERR_OFFLINE_RUNTIME_BLOCKED' });
    assert.throws(() => new globalObject.WebSocket('wss://example.invalid'), { code: 'ERR_OFFLINE_RUNTIME_BLOCKED' });
    await assert.rejects(electronNet.fetch('https://example.invalid'), { code: 'ERR_OFFLINE_RUNTIME_BLOCKED' });

    const audit = getOfflineNetworkAudit();
    assert.equal(audit.nodeAttempts.length, 9);
    assert.equal(audit.electronAttempts.length, 2);
  } finally {
    guard.restore();
  }
  assert.equal(modules.http.request(), undefined, 'restore returns the original functions');
  assert.deepEqual(await globalObject.fetch('local-test'), { ok: true });
});

test('Electron renderer session requests are cancelled and audited', () => {
  clearOfflineNetworkAudit();
  let intercept;
  const fakeSession = { webRequest: { onBeforeRequest(_filter, callback) { intercept = callback; } } };
  assert.equal(installOfflineSessionGuard(fakeSession), true);
  let decision;
  intercept({ resourceType: 'xhr', url: 'https://example.invalid/telemetry' }, value => { decision = value; });
  assert.deepEqual(decision, { cancel: true });
  assert.equal(getOfflineNetworkAudit().rendererAttempts.length, 1);
  assert.equal(installOfflineSessionGuard({}), false);
});

test('renderer exposes the offline-only update status as an informational state', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/App.jsx'), 'utf8');
  assert.match(source, /'offline-only'/);
  assert.match(source, /دون اتصال بالإنترنت/);
  assert.match(source, /حزمة محلية معتمدة/);
});
