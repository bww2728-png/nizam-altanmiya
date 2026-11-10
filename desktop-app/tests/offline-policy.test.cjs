'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { OFFLINE_RUNTIME_POLICY, updateStatus, isAllowedUpdateRequest, isAllowedRagflowRequest, installOfflineNetworkGuards, installOfflineSessionGuard, getOfflineNetworkAudit, clearOfflineNetworkAudit } = require('../src/main/offline-policy.cjs');

const ROOT = path.join(__dirname, '..');

test('runtime policy allows only scoped update connectivity', () => {
  assert.deepEqual(OFFLINE_RUNTIME_POLICY, {
    mode: 'restricted-network',
    networkAllowed: false,
    updateNetworkAllowed: true,
    cloudAiAllowed: false,
    localAiModelIncluded: false,
    automaticUpdatesEnabled: true,
    updateDistribution: 'github-releases',
  });
});

test('update status explains that only official updates use the network', () => {
  assert.deepEqual(updateStatus('0.5.3'), {
    state: 'idle',
    currentVersion: '0.5.3',
    message: 'يعمل النظام محليًا، وتُستخدم الشبكة للتحقق من تحديثات التطبيق الرسمية فقط.',
    updateDistribution: 'github-releases',
  });
});

test('update allowlist accepts official release metadata and assets only', () => {
  for (const request of [
    { protocol: 'https:', hostname: 'github.com', path: '/bww2728-png/nizam-altanmiya/releases.atom' },
    { protocol: 'https:', hostname: 'github.com', path: '/bww2728-png/nizam-altanmiya/releases/latest' },
    { protocol: 'https:', hostname: 'github.com', path: '/bww2728-png/nizam-altanmiya/releases/tag/v0.6.8' },
    { protocol: 'https:', hostname: 'github.com', path: '/bww2728-png/nizam-altanmiya/releases/download/v0.5.4/Local-Development-Intelligence-0.5.4-x64.exe' },
    { protocol: 'https:', hostname: 'release-assets.githubusercontent.com', path: '/download/test' },
  ]) assert.equal(isAllowedUpdateRequest(request), true);
  for (const request of [
    { protocol: 'http:', hostname: 'github.com', path: '/bww2728-png/nizam-altanmiya/releases/latest' },
    { protocol: 'https:', hostname: 'github.com', path: '/other/repo/releases/latest' },
    { protocol: 'https:', hostname: 'github.com', path: '/bww2728-png/nizam-altanmiya/releases/tag/vnot-semver' },
    { protocol: 'https:', hostname: 'github.com', path: '/bww2728-png/nizam-altanmiya/releases/download/v0.5.4/not-safe.exe', method: 'POST' },
    { protocol: 'https:', hostname: 'api.github.com', path: '/repos/bww2728-png/nizam-altanmiya' },
    'https://example.invalid/update.yml',
  ]) assert.equal(isAllowedUpdateRequest(request), false);
});

test('RAGFlow allowlist is limited to documented loopback endpoints and methods', () => {
  const datasetId = 'a'.repeat(32);
  const documentId = 'b'.repeat(32);
  for (const request of [
    { url: 'http://127.0.0.1:9380/api/v1/system/healthz' },
    { url: `http://127.0.0.1:9380/api/v1/datasets/${datasetId}/documents?id=${documentId}&page=1&page_size=1` },
    { url: 'http://127.0.0.1:9380/api/v1/retrieval', method: 'POST' },
    { url: `http://127.0.0.1:9380/api/v1/datasets/${datasetId}/documents`, method: 'POST' },
    { url: `http://127.0.0.1:9380/api/v1/datasets/${datasetId}/chunks`, method: 'POST' },
  ]) assert.equal(isAllowedRagflowRequest(request), true);
  for (const request of [
    { url: 'http://127.0.0.1:9380/api/v1/system/healthz?redirect=1' },
    { url: `http://127.0.0.1:9380/api/v1/datasets/${datasetId}/documents?id=${documentId}&admin=true` },
    { url: `http://127.0.0.1:9380/api/v1/datasets/${datasetId}/documents?id=invalid` },
    { url: `http://127.0.0.1:9380/api/v1/datasets/${datasetId}/chunks`, method: 'DELETE' },
    { url: 'http://localhost:9380/api/v1/retrieval', method: 'POST' },
    { url: 'http://127.0.0.1:9381/api/v1/retrieval', method: 'POST' },
    { url: 'https://example.invalid/api/v1/retrieval', method: 'POST' },
  ]) assert.equal(isAllowedRagflowRequest(request), false);
});

test('packaged main process initializes the restricted automatic updater', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/main/main.cjs'), 'utf8');
  assert.match(source, /require\(['"]electron-updater['"]\)/);
  assert.match(source, /autoUpdater\.checkForUpdates\(\)/);
  assert.match(source, /setupAutoUpdate\(\)/);
  assert.match(source, /installOfflineNetworkGuards\(\{ electronNet: net, allowedNetworkRequest: \(request, init\) => isAllowedUpdateRequest\(request\) \|\| isAllowedRagflowRequest\(request, init\) \}\)/);
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
  const guard = installOfflineNetworkGuards({
    modules,
    globalObject,
    electronNet,
    allowedNetworkRequest: (request, init) => isAllowedUpdateRequest(request) || isAllowedRagflowRequest(request, init),
  });
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
    assert.equal(electronNet.request({ protocol: 'https:', hostname: 'github.com', path: '/bww2728-png/nizam-altanmiya/releases.atom' }), 'request');
    assert.equal(electronNet.request({ protocol: 'https:', hostname: 'github.com', path: '/bww2728-png/nizam-altanmiya/releases/tag/v0.6.8', method: 'GET', session: {} }), 'request');
    assert.deepEqual(await electronNet.fetch('https://release-assets.githubusercontent.com/download/update.exe'), { ok: true });
    assert.deepEqual(await electronNet.fetch('http://127.0.0.1:9380/api/v1/retrieval', { method: 'POST' }), { ok: true });

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

test('renderer exposes visible states for automatic update progress', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/App.jsx'), 'utf8');
  assert.match(source, /'downloading'/);
  assert.match(source, /جارٍ تنزيل التحديث/);
  assert.doesNotMatch(source, /offline-only/);
});
