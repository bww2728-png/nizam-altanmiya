'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Derive the next release version from the base package version and the CI run
 * number. electron-updater only installs a release whose version is strictly
 * greater than the installed one, so the patch segment must never move
 * backwards: it takes whichever is larger, the run number or patch + 1.
 *
 * @param {string} current  base version from package.json, e.g. "0.6.0"
 * @param {number|string} runNumber  GITHUB_RUN_NUMBER (strictly increasing)
 * @returns {string} the version to build
 */
function computeVersion(current, runNumber) {
  const [major = 0, minor = 0, patch = 0] = String(current || '0.0.0')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const run = Number.parseInt(runNumber, 10) || 1;
  return [major, minor, Math.max(run, patch + 1)].join('.');
}

/**
 * Read a package.json, set its version and write it back unchanged otherwise.
 * Returns the version written.
 */
function applyVersion(packageFile, runNumber) {
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const version = computeVersion(pkg.version, runNumber);
  pkg.version = version;
  fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  return version;
}

if (require.main === module) {
  const file = path.join(__dirname, '..', 'package.json');
  process.stdout.write(applyVersion(file, process.env.GITHUB_RUN_NUMBER));
}

module.exports = { computeVersion, applyVersion };