'use strict';

/**
 * Runtime policy for the Ministry's offline desktop deployment.
 *
 * Build/release automation may use network services outside the installed app.
 * The installed application itself must not call remote APIs, telemetry,
 * cloud AI, or automatic update services.
 */
const OFFLINE_RUNTIME_POLICY = Object.freeze({
  mode: 'offline-only',
  networkAllowed: false,
  cloudAiAllowed: false,
  localAiModelIncluded: false,
  automaticUpdatesEnabled: false,
  updateDistribution: 'local-installer-package',
});

function offlineUpdateStatus(currentVersion = '') {
  return {
    state: 'offline-only',
    currentVersion: String(currentVersion || ''),
    message: 'يعمل النظام محليًا دون اتصال بالإنترنت. تُثبَّت التحديثات من حزمة محلية معتمدة.',
    updateDistribution: OFFLINE_RUNTIME_POLICY.updateDistribution,
  };
}



const OFFLINE_NETWORK_AUDIT = {
  nodeAttempts: [],
  electronAttempts: [],
  rendererAttempts: [],
};

function offlineBlockedError(api) {
  const error = new Error('تم حظر اتصال شبكي لأن سياسة التطبيق محلية دون اتصال: ' + api);
  error.code = 'ERR_OFFLINE_RUNTIME_BLOCKED';
  error.api = api;
  return error;
}

function recordBlockedAttempt(channel, api) {
  const item = { api: String(api), at: new Date().toISOString() };
  const bucket = channel === 'renderer' ? OFFLINE_NETWORK_AUDIT.rendererAttempts
    : channel === 'electron' ? OFFLINE_NETWORK_AUDIT.electronAttempts
      : OFFLINE_NETWORK_AUDIT.nodeAttempts;
  bucket.push(item);
  return offlineBlockedError(api);
}

/**
 * Defensively blocks network-capable Node/Electron APIs in the installed app.
 * This is application-layer enforcement; OS firewall policy is still required
 * to constrain native add-ons and operating-system services outside Node.
 */
function installOfflineNetworkGuards(options = {}) {
  const modules = options.modules ?? {
    http: require('node:http'),
    https: require('node:https'),
    net: require('node:net'),
    tls: require('node:tls'),
    dns: require('node:dns'),
    dgram: require('node:dgram'),
  };
  const electronNet = options.electronNet ?? null;
  const globalObject = options.globalObject ?? globalThis;
  const restorers = [];

  const patch = (target, key, replacement) => {
    if (!target || typeof target[key] !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || descriptor.writable === false && !descriptor.set) return;
    try {
      Object.defineProperty(target, key, { ...descriptor, value: replacement });
      restorers.push(() => {
        try { Object.defineProperty(target, key, descriptor); } catch { /* best effort */ }
      });
    } catch { /* a non-configurable native method remains covered by other guards */ }
  };

  const block = (channel, api) => function offlineNetworkBlocked() {
    throw recordBlockedAttempt(channel, api);
  };

  for (const method of ['request', 'get']) {
    patch(modules.http, method, block('node', 'http.' + method));
    patch(modules.https, method, block('node', 'https.' + method));
  }
  for (const method of ['connect', 'createConnection']) {
    patch(modules.net, method, block('node', 'net.' + method));
  }
  if (modules.net?.Socket?.prototype) {
    patch(modules.net.Socket.prototype, 'connect', block('node', 'net.Socket.connect'));
  }
  patch(modules.tls, 'connect', block('node', 'tls.connect'));
  for (const method of [
    'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
    'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
    'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse',
  ]) {
    patch(modules.dns, method, block('node', 'dns.' + method));
  }
  patch(modules.dgram, 'createSocket', block('node', 'dgram.createSocket'));

  patch(globalObject, 'fetch', function offlineFetchBlocked() {
    const error = recordBlockedAttempt('node', 'global.fetch');
    return Promise.reject(error);
  });
  if (typeof globalObject.WebSocket === 'function') {
    patch(globalObject, 'WebSocket', block('node', 'global.WebSocket'));
  }

  patch(electronNet, 'request', block('electron', 'electron.net.request'));
  patch(electronNet, 'fetch', function offlineElectronFetchBlocked() {
    const error = recordBlockedAttempt('electron', 'electron.net.fetch');
    return Promise.reject(error);
  });

  return {
    get audit() { return getOfflineNetworkAudit(); },
    restore() {
      for (const restore of restorers.reverse()) restore();
      restorers.length = 0;
    },
  };
}

/** Cancel all renderer-originated external protocols in one place. */
function installOfflineSessionGuard(electronSession) {
  if (!electronSession?.webRequest?.onBeforeRequest) return false;
  electronSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      recordBlockedAttempt('renderer', details.resourceType ?? 'renderer-request');
      callback({ cancel: true });
    }
  );
  return true;
}

function getOfflineNetworkAudit() {
  return {
    nodeAttempts: [...OFFLINE_NETWORK_AUDIT.nodeAttempts],
    electronAttempts: [...OFFLINE_NETWORK_AUDIT.electronAttempts],
    rendererAttempts: [...OFFLINE_NETWORK_AUDIT.rendererAttempts],
  };
}

function clearOfflineNetworkAudit() {
  OFFLINE_NETWORK_AUDIT.nodeAttempts.length = 0;
  OFFLINE_NETWORK_AUDIT.electronAttempts.length = 0;
  OFFLINE_NETWORK_AUDIT.rendererAttempts.length = 0;
}

module.exports = { OFFLINE_RUNTIME_POLICY, offlineUpdateStatus, installOfflineNetworkGuards, installOfflineSessionGuard, getOfflineNetworkAudit, clearOfflineNetworkAudit };
