'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.cjs'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'App.jsx'), 'utf8');
const pkg = require(path.join(ROOT, 'package.json'));
const { computeVersion, applyVersion } = require(path.join(ROOT, 'scripts', 'ci-version.cjs'));

test('main process loads electron-updater optionally and wires it at startup', () => {
  assert.match(mainSource, /require\('electron-updater'\)/);
  assert.match(mainSource, /function setupAutoUpdate\(\)/);
  assert.match(mainSource, /autoUpdater\.checkForUpdates\(\)/);
  assert.match(mainSource, /setupAutoUpdate\(\);/);
});

test('update channels are real handlers rather than offline stubs', () => {
  assert.match(mainSource, /ipcMain\.handle\('update:status', \(\) => \(\{ \.\.\.lastUpdateStatus/);
  assert.match(mainSource, /ipcMain\.handle\('update:check', async \(\) =>/);
  assert.match(mainSource, /ipcMain\.handle\('update:install', \(\) =>/);
  assert.match(mainSource, /quitAndInstall\(\)/);
  assert.match(mainSource, /installOfflineNetworkGuards\(\{ electronNet: net, allowedNetworkRequest: \(request, init\) => isAllowedUpdateRequest\(request\) \|\| isAllowedRagflowRequest\(request, init\) \}\)/);
  assert.match(mainSource, /installOfflineSessionGuard\(session\.defaultSession\)/);
  assert.doesNotMatch(mainSource, /offline-only/);
});

test('renderer shows automatic update progress without an offline-only state', () => {
  assert.match(appSource, /'downloading'/);
  assert.match(appSource, /'downloaded'/);
  assert.match(appSource, /installUpdate/);
  assert.doesNotMatch(appSource, /offline-only/);
});

test('package publishes to the public GitHub repository', () => {
  const publish = pkg.build?.publish?.[0];
  assert.equal(publish?.provider, 'github');
  assert.equal(publish?.owner, 'bww2728-png');
  assert.equal(publish?.repo, 'nizam-altanmiya');
  assert.equal(publish?.releaseType, 'release');
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater is a runtime dependency');
});

test('CI derives a strictly increasing version so the updater never stalls', () => {
  assert.equal(computeVersion('0.6.0', 1), '0.6.1');
  assert.equal(computeVersion('0.6.0', 42), '0.6.42');
  // A small run number must not move the patch segment backwards.
  assert.equal(computeVersion('0.6.9', 3), '0.6.10');
  // Missing run numbers fall back to the next patch.
  assert.equal(computeVersion('0.6.3', undefined), '0.6.4');
  // A two-segment base must not produce NaN.
  assert.equal(computeVersion('1.2', 5), '1.2.5');
});

test('applyVersion rewrites only the version and keeps the rest of package.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-version-'));
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'demo', version: '0.6.0', dependencies: { a: '1' } }, null, 2));
  try {
    const version = applyVersion(file, 12);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(version, '0.6.12');
    assert.equal(written.version, '0.6.12');
    assert.equal(written.name, 'demo');
    assert.deepEqual(written.dependencies, { a: '1' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});