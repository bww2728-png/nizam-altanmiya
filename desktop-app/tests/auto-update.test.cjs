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

test('the installer arrives as one continuous stream, not per-block ranged requests', () => {
  assert.match(mainSource, /autoUpdater\.disableDifferentialDownload = true;/);
});

test('a failed update retries automatically with no attempt counter', () => {
  assert.match(mainSource, /const UPDATE_RETRY_DELAY_MS = 15 \* 60 \* 1_000;/);
  assert.match(mainSource, /const UPDATE_DOWNLOAD_RETRY_DELAY_MS = 60 \* 60 \* 1_000;/);
  // The phase picks the delay, and every phase that can fail after the check is
  // listed: dropping 'available' or 'downloading' would re-check every 15 minutes.
  assert.match(mainSource, /const failedWhileChecking = !\['available', 'downloading', 'downloaded'\]\.includes\(failedPhase\);/);
  assert.match(mainSource, /failedWhileChecking \? UPDATE_RETRY_DELAY_MS : UPDATE_DOWNLOAD_RETRY_DELAY_MS/);
  assert.doesNotMatch(mainSource, /UPDATE_RETRY_LIMIT|retryAttempts/);
  assert.match(mainSource, /function scheduleUpdateRetry\(delay\)/);
  assert.match(mainSource, /if \(updateStopped \|\| updateTimers\.retry\) return;/);
  assert.match(mainSource, /if \(updateTimers\.retry\) clearTimeout\(updateTimers\.retry\);/);
  // Every success path disarms the pending retry, in the handler that owns it.
  const handlers = mainSource.slice(mainSource.indexOf("autoUpdater.on('update-available'"), mainSource.indexOf("autoUpdater.on('error'"));
  for (const phase of ['available', 'not-available', 'downloaded']) {
    assert.match(
      handlers,
      new RegExp("clearUpdateRetry\\(\\);\\s*pushUpdateStatus\\(\\{ state: '" + phase + "'"),
      'retry cleared in the ' + phase + ' handler',
    );
  }
});

test('the manual check reports its own phase instead of inheriting a stale one', () => {
  assert.match(mainSource, /pushUpdateStatus\(\{ state: 'error', phase: lastUpdateStatus\.state, message:/);
});

test('the retry is gated by the transfer phase, not by a state the error may never reach', () => {
  // A failed install used to leave the sticky 'downloaded' state in place, so the
  // error was swallowed and the retry returned without doing anything.
  assert.match(mainSource, /if \(failedPhase === 'downloaded'\) lastUpdateStatus = \{ state: 'error' \};/);
  assert.doesNotMatch(mainSource, /lastUpdateStatus\.state !== 'error'\) return;/);
  assert.match(mainSource, /if \(state === 'downloading' \|\| state === 'downloaded'\) return;/);
  // A quit stops the loop before any new check is issued.
  const retryBody = mainSource.slice(mainSource.indexOf('updateTimers.retry = setTimeout('));
  assert.match(retryBody.slice(0, 600), /if \(updateStopped\) return;/);
});

test('the ready state is dropped before the failure is published', () => {
  // Order matters: publishing first lets the sticky 'downloaded' guard swallow the
  // message, and the retry then has no recorded failure to act on.
  const phaseRead = mainSource.indexOf('const failedPhase = lastUpdateStatus.state;');
  const reset = mainSource.indexOf("if (failedPhase === 'downloaded') lastUpdateStatus = { state: 'error' };");
  const publish = mainSource.indexOf("pushUpdateStatus({ state: 'error', phase: failedPhase");
  const arm = mainSource.indexOf('scheduleUpdateRetry(failedWhileChecking ?');
  assert.ok(phaseRead > 0, 'the phase is read from the current status');
  assert.ok(phaseRead < reset, 'the phase is read before the status is replaced');
  assert.ok(reset > 0 && publish > reset, 'the reset must come before the error is published');
  assert.ok(arm > publish, 'the retry is armed after the failure is recorded');
});

test('a ready build is never replaced by a poll, a manual check or a stray install', () => {
  const poll = mainSource.slice(mainSource.indexOf('const checkForUpdates = () => {'));
  assert.match(poll.slice(0, 400), /if \(lastUpdateStatus\.state === 'downloaded'\) return;/);
  assert.match(mainSource, /if \(lastUpdateStatus\.state === 'downloaded'\) return \{ \.\.\.lastUpdateStatus, currentVersion: app\.getVersion\(\) \};/);
  assert.match(mainSource, /if \(!autoUpdater \|\| lastUpdateStatus\.state !== 'downloaded'\) return false;/);
});

test('quitting disarms the retry and the poll', () => {
  const stop = mainSource.slice(mainSource.indexOf('function stopAutoUpdate() {'));
  assert.match(stop.slice(0, 600), /updateStopped = true;/);
  assert.match(stop.slice(0, 600), /clearTimeout\(updateTimers\.retry\)/);
  assert.match(stop.slice(0, 600), /clearInterval\(updateTimers\.interval\)/);
  assert.match(mainSource, /app\.on\('before-quit', \(\) => \{\s*stopAutoUpdate\(\);/);
});

test('a rejected download promise is handled instead of reaching the process', () => {
  // checkForUpdates returns { downloadPromise }; it rejects on any transfer failure.
  const handled = (mainSource.match(/downloadPromise\?\.catch\?\.\(\(\) => \{\}\)/g) ?? []).length;
  assert.ok(handled >= 2, 'both the poll and the manual check attach a catch, found ' + handled);
});

test('an install failure is reported as an install failure in the banner', () => {
  assert.match(appSource, /status\?\.phase === 'downloaded'/);
  assert.match(appSource, /تعذّر تشغيل مثبّت التحديث/);
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
  assert.equal(pkg.build?.compression, 'maximum', 'the installer is packed with maximum compression');
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