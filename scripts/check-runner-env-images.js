#!/usr/bin/env node
/**
 * The runner-env images and the list the backend is told about agree.
 *
 * images/runner-env/settings.json is the curated list in the shape the
 * backend's HOSTED_RUNNERS_SETTINGS_FILE takes (`images.<name>`). Each
 * entry must name a target the Dockerfile builds, tagged
 * `<name>-<RUNNER_VERSION>` with the runner version the Dockerfile pins,
 * and that pin must be a release the runner package has reached. A tag
 * that names a flavour nobody builds, or a pin that moved without the
 * tags, is an environment that cannot start. The backend's built-in image
 * list must be a subset of settings.json, and the CI workflow must build
 * and smoke-test exactly the listed flavours.
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

if (!pin || !SEMVER.test(pin)) {
  findings.push(`Dockerfile: ARG RUNNER_VERSION must default to an exact x.y.z version, found ${pin || 'none'}.`);
} else {
  const a = SEMVER.exec(pin).slice(1).map(Number);
  const b = (SEMVER.exec(runnerPkg.version) || []).slice(1).map(Number);
  const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (b.length === 3 && cmp > 0) {
    findings.push(`Dockerfile pins @almyty/runner ${pin}, newer than packages/runner (${runnerPkg.version}).`);
  }
}

const images = settings && settings.images;
if (!images || typeof images !== 'object' || Object.keys(images).length === 0) {
  findings.push('settings.json: `images` must list at least one image.');
} else {
  for (const [name, ref] of Object.entries(images)) {
    if (!targets.has(name)) findings.push(`settings.json: "${name}" is not a target in the Dockerfile (targets: ${[...targets].join(', ')}).`);
    if (name === 'base' || name === 'runner-pkg') findings.push(`settings.json: "${name}" is an internal stage, not a flavour.`);
    const want = `almyty/runner-env:${name}-${pin}`;
    if (ref !== want && !String(ref).startsWith(`${want}@sha256:`)) {
      findings.push(`settings.json: "${name}" is ${ref}; expected ${want} (optionally @sha256:<digest>).`);
    }
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
    const listed = images && images[name];
    if (!listed) {
      findings.push(`hosted-runner-settings.ts: the default image "${name}" is not in settings.json, so CI does not build it.`);
    } else if (listed !== ref) {
      findings.push(`hosted-runner-settings.ts: the default image "${name}" is ${ref}; settings.json says ${listed}.`);
    }
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
console.log(`check-runner-env-images: OK — ${Object.keys(images).length} images at @almyty/runner ${pin}.`);
