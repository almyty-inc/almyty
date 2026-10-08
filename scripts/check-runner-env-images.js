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
 * tags, is an environment that cannot start.
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

if (!fs.existsSync(path.join(dir, 'entrypoint.sh'))) findings.push('entrypoint.sh is missing.');
if (!/^USER 1000:1000\s*$/m.test(dockerfile)) findings.push('Dockerfile: the images must run as USER 1000:1000, the uid the hosted Deployment sets.');

if (findings.length) {
  console.error('check-runner-env-images: FAIL\n');
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-runner-env-images: OK — ${Object.keys(images).length} images at @almyty/runner ${pin}.`);
