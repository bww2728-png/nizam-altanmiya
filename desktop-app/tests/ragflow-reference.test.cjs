const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateManifest, validateReference } = require('../../tools/validate-ragflow-reference.cjs');

const repositoryRoot = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'infra/ragflow/deployment-manifest.json'), 'utf8'));

test('validates the checked-out upstream RAGFlow tag and Compose configuration', () => {
  const result = validateReference(repositoryRoot, manifest);
  assert.equal(result.tag, 'v1.0.0');
  assert.equal(result.commit, 'db1cd5929a7885a3074547791f5ecc4d2f891739');
  assert.equal(result.readiness, 'reference-only-not-deployable');
  assert.ok(result.requiredServices.includes('tei-cpu'));
});

test('rejects a changed upstream pin', () => {
  const alteredManifest = structuredClone(manifest);
  alteredManifest.integration.commit = '0'.repeat(40);
  assert.throws(() => validateManifest(alteredManifest), /pinned to v1\.0\.0/);
});

test('rejects claims that Windows or offline packaging are ready', () => {
  const alteredManifest = structuredClone(manifest);
  alteredManifest.readiness.windowsRuntimeTested = true;
  assert.throws(() => validateManifest(alteredManifest), /must not be claimed/);
});

test('keeps embedding choice explicitly pending evaluation', () => {
  const alteredManifest = structuredClone(manifest);
  alteredManifest.upstreamDeploymentReference.defaultEmbeddingService.modelStatus = 'selected';
  assert.throws(() => validateManifest(alteredManifest), /model unselected/);
});
