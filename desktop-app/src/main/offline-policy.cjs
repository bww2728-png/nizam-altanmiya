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

module.exports = { OFFLINE_RUNTIME_POLICY, offlineUpdateStatus };
