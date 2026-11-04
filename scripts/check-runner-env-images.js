#!/usr/bin/env node
/**
 * The runner-env images and the list the backend is told about agree.
 *
 * images/runner-env/settings.json is the curated list in the shape the
 * backend's HOSTED_RUNNERS_SETTINGS_FILE takes (`images.<name>`). Each
 * entry must name a target the Dockerfile builds, as an image CI has
 * pushed: `almyty/runner-env:<name>-<x.y.z>@sha256:<digest>`. A tag with
 * no digest names an image that may not exist (the images are pushed only
 * from master and v* tags), so it is refused.
 *
 * The references may trail the Dockerfile: bumping RUNNER_VERSION comes
 * first, the release pushes the new images, and a follow-up pins their
 * digests. Until then the references stay on the last pushed images. A
 * reference that names a runner newer than the Dockerfile's pin is
 * refused, and the pin must be a release the runner package has reached.
 *
 * The backend's built-in image list and the pre-pull DaemonSet
 * (docs/design/hosted-runners/image-prepull.yaml) must use references from
 * settings.json, and the CI workflow must build and smoke-test exactly the
 * listed flavours.
 *
 * Same shape as the other repo checks: Node + a checkout, no install.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'images', 'runner-env');
const findings = [];

const dockerfile = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
const runnerPkg = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'runner', 'package.json'), 'utf8'));

const pin = (/^ARG RUNNER_VERSION=(\S+)\s*$/m.exec(dockerfile) || [])[1];
const targets = new Set([...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)\s*$/gim)].map((m) => m[1]));
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const semver = (v) => (SEMVER.exec(v) || []).slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const pinParts = pin && SEMVER.test(pin) ? semver(pin) : null;

if (!pinParts) {
  findings.push(`Dockerfile: ARG RUNNER_VERSION must default to an exact x.y.z version, found ${pin || 'none'}.`);
} else {
  const b = semver(runnerPkg.version);
  if (b.length === 3 && compare(pinParts, b) > 0) {
    findings.push(`Dockerfile pins @almyty/runner ${pin}, newer than packages/runner (${runnerPkg.version}).`);
  }
}

// A reference to a pushed image: the flavour's tag at a runner version no
// newer than the Dockerfile's, pinned by digest.
function checkRef(where, name, ref) {
  const m = /^almyty\/runner-env:([A-Za-z0-9_-]+?)-(\d+\.\d+\.\d+)(@sha256:[0-9a-f]{64})?$/.exec(String(ref));
  const shape = `almyty/runner-env:${name}-<x.y.z>@sha256:<64 hex digest>`;
  if (!m || m[1] !== name) {
    findings.push(`${where}: "${name}" is ${ref}; expected ${shape}.`);
    return;
  }
  if (!m[3]) {
    findings.push(`${where}: "${name}" is ${ref} with no @sha256: digest. Reference only pushed images, pinned by digest (${shape}).`);
  }
  if (pinParts && compare(semver(m[2]), pinParts) > 0) {
    findings.push(`${where}: "${name}" names runner ${m[2]}, newer than the Dockerfile's RUNNER_VERSION ${pin}.`);
  }
}

const images = settings && settings.images;
if (!images || typeof images !== 'object' || Object.keys(images).length === 0) {
  findings.push('settings.json: `images` must list at least one image.');
} else {
  for (const [name, ref] of Object.entries(images)) {
    if (!targets.has(name)) findings.push(`settings.json: "${name}" is not a target in the Dockerfile (targets: ${[...targets].join(', ')}).`);
    if (name === 'base' || name === 'runner-pkg') findings.push(`settings.json: "${name}" is an internal stage, not a flavour.`);
    checkRef('settings.json', name, ref);
  }
}

// The backend's built-in `images` (what an install offers before any
// settings file) name images CI pushes: each one is in settings.json, with
// the same reference.
const backendSettingsPath = path.join(root, 'backend', 'src', 'modules', 'hosted-runners', 'hosted-runner-settings.ts');
const backendSettings = fs.readFileSync(backendSettingsPath, 'utf8');
const defaultsBlock = (/DEFAULT_HOSTED_RUNNER_SETTINGS[\s\S]*?\n\s*images:\s*\{([\s\S]*?)\}/.exec(backendSettings) || [])[1];
if (!defaultsBlock) {
  findings.push('hosted-runner-settings.ts: no `images` in DEFAULT_HOSTED_RUNNER_SETTINGS.');
} else {
  const defaults = [...defaultsBlock.matchAll(/['"]?([A-Za-z0-9_-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)];
  if (defaults.length === 0) findings.push('hosted-runner-settings.ts: DEFAULT_HOSTED_RUNNER_SETTINGS.images lists no image.');
  for (const [, name, ref] of defaults) {
    checkRef('hosted-runner-settings.ts', name, ref);
    const listed = images && images[name];
    if (!listed) {
      findings.push(`hosted-runner-settings.ts: the default image "${name}" is not in settings.json, so CI does not build it.`);
    } else if (listed !== ref) {
      findings.push(`hosted-runner-settings.ts: the default image "${name}" is ${ref}; settings.json says ${listed}.`);
    }
  }
}

// The pre-pull DaemonSet pulls images the pods will run: each one is a
// settings.json reference.
const prepullPath = path.join(root, 'docs', 'design', 'hosted-runners', 'image-prepull.yaml');
if (fs.existsSync(prepullPath)) {
  const prepull = fs.readFileSync(prepullPath, 'utf8');
  const refs = [...prepull.matchAll(/^\s*image:\s*['"]?(\S*runner-env\S*?)['"]?\s*$/gm)].map((m) => m[1]);
  const listed = new Set(Object.values(images || {}));
  for (const ref of refs) {
    const name = (/^almyty\/runner-env:([A-Za-z0-9_-]+?)-\d/.exec(ref) || [])[1] || ref;
    checkRef('image-prepull.yaml', name, ref);
    if (!listed.has(ref)) findings.push(`image-prepull.yaml: pulls ${ref}, which settings.json does not list.`);
  }
}

// CI builds, smoke-tests and pushes every listed image.
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'runner-env-images.yml'), 'utf8');
const matrices = [...workflow.matchAll(/^\s*flavour:\s*\[([^\]]*)\]/gm)].map((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
if (matrices.length < 2) findings.push('runner-env-images.yml: expected a `flavour` matrix on both the build and the push job.');
for (const list of matrices) {
  const want = Object.keys(images || {}).sort().join(', ');
  if ([...list].sort().join(', ') !== want) findings.push(`runner-env-images.yml: a flavour matrix lists [${list.join(', ')}]; settings.json lists [${want}].`);
}
if (!/images\/runner-env\/smoke\.sh/.test(workflow)) findings.push('runner-env-images.yml: the build job must run images/runner-env/smoke.sh.');

if (!fs.existsSync(path.join(dir, 'entrypoint.sh'))) findings.push('entrypoint.sh is missing.');
if (!/^USER 1000:1000\s*$/m.test(dockerfile)) findings.push('Dockerfile: the images must run as USER 1000:1000, the uid the hosted Deployment sets.');

if (findings.length) {
  console.error('check-runner-env-images: FAIL\n');
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-runner-env-images: OK — ${Object.keys(images).length} pinned images, Dockerfile at @almyty/runner ${pin}.`);
