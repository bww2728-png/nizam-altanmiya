const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
function readText(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Required RAGFlow reference file is missing: ${relativePath}`);
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function requireMatch(contents, expression, description) {
  if (!expression.test(contents)) {
    throw new Error(`RAGFlow reference check failed: ${description}`);
  }
}

function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1) {
    throw new Error('Unsupported deployment manifest schemaVersion.');
  }
  if (manifest.integration?.type !== 'git-submodule') {
    throw new Error('RAGFlow must be represented by its pinned Git submodule.');
  }
  if (manifest.integration?.repository !== 'https://github.com/infiniflow/ragflow.git') {
    throw new Error('Unexpected RAGFlow upstream repository.');
  }
  if (manifest.integration?.tag !== 'v1.0.0' || manifest.integration?.commit !== 'db1cd5929a7885a3074547791f5ecc4d2f891739') {
    throw new Error('RAGFlow must remain pinned to v1.0.0 at the approved commit.');
  }
  if (manifest.readiness?.status !== 'reference-only-not-deployable' || manifest.readiness?.productComposeOverlay !== null) {
    throw new Error('Do not mark the upstream reference as a deployable product configuration.');
  }
  if (manifest.readiness?.windowsRuntimeTested !== false || manifest.readiness?.offlinePackageBuilt !== false) {
    throw new Error('Windows and offline readiness must not be claimed before actual validation.');
  }
  if (manifest.upstreamDeploymentReference?.defaultEmbeddingService?.modelStatus !== 'not-selected' || manifest.upstreamDeploymentReference.defaultEmbeddingService.enabledByUpstreamDefault !== false) {
    throw new Error('The optional embedding profile must remain disabled and its model unselected pending benchmarks.');
  }
  if (!Array.isArray(manifest.readiness?.blockingGates) || manifest.readiness.blockingGates.length === 0) {
    throw new Error('Deployment readiness blockers must be documented.');
  }
}

function validateReference(root = repositoryRoot, manifest = JSON.parse(readText(root, 'infra/ragflow/deployment-manifest.json'))) {
  validateManifest(manifest);

  const submodulePath = manifest.integration.path;
  const gitmodules = readText(root, '.gitmodules');
  requireMatch(gitmodules, new RegExp(`path\\s*=\\s*${submodulePath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`), 'submodule path is registered in .gitmodules');
  requireMatch(gitmodules, /url\s*=\s*https:\/\/github\.com\/infiniflow\/ragflow\.git/, 'submodule points to official upstream');

  const submoduleRoot = path.join(root, submodulePath);
  let actualCommit;
  let workingTree;
  try {
    actualCommit = execFileSync('git', ['-C', submoduleRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    workingTree = execFileSync('git', ['-C', submoduleRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`Unable to inspect the RAGFlow submodule: ${error.message}`);
  }
  if (actualCommit !== manifest.integration.commit) {
    throw new Error(`RAGFlow checkout mismatch: expected ${manifest.integration.tag} (${manifest.integration.commit}), got ${actualCommit}.`);
  }
  if (workingTree) {
    throw new Error('The RAGFlow submodule working tree is modified; restore or review it before validating the reference.');
  }

  const compose = readText(root, manifest.upstreamDeploymentReference.composeEntrypoint);
  const composeBase = readText(root, manifest.upstreamDeploymentReference.composeBase);
  const environment = readText(root, manifest.upstreamDeploymentReference.environmentReference);
  requireMatch(compose, /\.\/docker-compose-base\.yml/, 'upstream Compose includes its matching base file');
  requireMatch(compose, /ragflow-cpu:/, 'Go CPU service exists in the pinned Compose file');
  requireMatch(compose, /image:\s*\$\{RAGFLOW_IMAGE\}/, 'RAGFlow image is configured through the pinned release environment');
  for (const service of manifest.upstreamDeploymentReference.requiredServices) {
    const serviceSource = service === 'ragflow-cpu' ? compose : composeBase;
    if (!serviceSource.split('\n').includes(`  ${service}:`)) {
      throw new Error(`RAGFlow reference check failed: upstream service ${service} exists`);
    }
  }
  requireMatch(environment, /^RAGFLOW_IMAGE=infiniflow\/ragflow:v1\.0\.0$/m, 'environment references the same RAGFlow release');
  requireMatch(environment, /^TEI_IMAGE_CPU=infiniflow\/text-embeddings-inference:cpu-1\.8$/m, 'CPU embedding service uses an explicit upstream image tag');
  requireMatch(environment, /^DOC_ENGINE=\$\{DOC_ENGINE:-elasticsearch\}$/m, 'upstream default document engine is recorded accurately');
  requireMatch(environment, /^DEVICE=\$\{DEVICE:-cpu\}$/m, 'upstream default device profile is recorded accurately');
  requireMatch(environment, /^METADATA_DB_PROFILE=\$\{METADATA_DB_PROFILE:-mysql\}$/m, 'upstream default metadata profile is recorded accurately');

  return {
    tag: manifest.integration.tag,
    commit: actualCommit,
    requiredServices: manifest.upstreamDeploymentReference.requiredServices,
    readiness: manifest.readiness.status
  };
}

if (require.main === module) {
  try {
    const result = validateReference();
    console.log(`RAGFlow reference verified: ${result.tag} (${result.commit})`);
    console.log(`Deployment status: ${result.readiness}; no services were started.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { validateManifest, validateReference };
