#!/usr/bin/env node
// Wait until npm serves every @almyty/* version this checkout releases.
//
// post-release.yml starts seconds after publish-packages.yml finishes, and
// npm can take minutes to serve a version it has just accepted: an install
// in that window fails with ETARGET (v0.2.27 did, on @almyty/runner@^1.5.9).
// So before anything installs, this polls
//
//   npm view <name>@<version> version --prefer-online
//
// for each publishable package under packages/ (names and versions from
// their package.json), backing off from 5s to 60s between rounds, for up to
// 20 minutes. It exits 0 once npm serves all of them, and 1 naming each one
// it still does not serve.
//
//   node scripts/wait-for-npm.js
//
// WAIT_FOR_NPM_TIMEOUT_SECONDS, WAIT_FOR_NPM_INTERVAL_SECONDS and
// WAIT_FOR_NPM_MAX_INTERVAL_SECONDS override those numbers (the tests do).

'use strict';

const { spawnSync } = require('child_process');
const { publishable } = require('./release-packages.js');

/** True when npm serves exactly `name@version`. */
function npmServes(name, version) {
  const r = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--prefer-online'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === version;
}

/**
 * Poll `serves(name, version)` for each package until npm serves all of
 * them or `timeoutMs` has passed. Resolves to the packages still missing,
 * [] when none is.
 */
async function waitForNpm(packages, {
  serves = npmServes,
  timeoutMs = 20 * 60 * 1000,
  intervalMs = 5000,
  maxIntervalMs = 60 * 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  log = console.log,
} = {}) {
  const deadline = now() + timeoutMs;
  let pending = packages.slice();
  let wait = intervalMs;
  for (;;) {
    pending = pending.filter((p) => !serves(p.name, p.version));
    if (!pending.length) return [];
    const left = deadline - now();
    if (left <= 0) return pending;
    const pause = Math.min(wait, left);
    log(`npm does not serve ${pending.map((p) => `${p.name}@${p.version}`).join(', ')} yet; checking again in ${(pause / 1000).toFixed(1)}s`);
    await sleep(pause);
    wait = Math.min(wait * 2, maxIntervalMs);
  }
}

/** The publishable packages under `root`, as { name, version }. */
function released(root) {
  return publishable(root).map((p) => ({ name: p.manifest.name, version: p.manifest.version }));
}

module.exports = { waitForNpm, npmServes, released };

if (require.main === module) {
  const ms = (name, fallback) => (process.env[name] ? Number(process.env[name]) * 1000 : fallback);
  const timeoutMs = ms('WAIT_FOR_NPM_TIMEOUT_SECONDS', 20 * 60 * 1000);
  const packages = released();
  waitForNpm(packages, {
    timeoutMs,
    intervalMs: ms('WAIT_FOR_NPM_INTERVAL_SECONDS', 5000),
    maxIntervalMs: ms('WAIT_FOR_NPM_MAX_INTERVAL_SECONDS', 60 * 1000),
  }).then((missing) => {
    if (!missing.length) {
      console.log(`npm serves all ${packages.length}: ${packages.map((p) => `${p.name}@${p.version}`).join(', ')}`);
      return;
    }
    const msg = `npm still does not serve ${missing.map((p) => `${p.name}@${p.version}`).join(', ')} after ${timeoutMs / 1000}s`;
    console.error(process.env.GITHUB_ACTIONS === 'true' ? `::error title=wait-for-npm::${msg}` : `wait-for-npm: ${msg}`);
    process.exit(1);
  });
}
