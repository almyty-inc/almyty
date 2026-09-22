#!/usr/bin/env node
// Lockfile freshness gate for packages/*.
//
// A rotted package-lock.json is invisible until someone runs `npm ci`, and
// `npm ci` does not warn about it, it refuses. Two had rotted unnoticed:
// models-cli's lock still said 0.1.0 against a package.json at 1.2.0, and
// almyty-cli's was missing two dependencies outright. The cost was not
// local — CI could not use `npm ci` for ANY package leg because of those
// two, so every leg installed with `npm install` and tested a dependency
// graph the published artifact was never built from.
//
// This runs the two cheap checks `npm ci` makes before it does anything
// else, offline and in milliseconds, so the rot fails on the commit that
// causes it instead of on whoever next tries to tighten the workflow.
//
// No dependencies — just Node's fs. Exits 0 when every lock agrees with
// its manifest, 1 with a report otherwise.

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const packagesDir = path.join(repoRoot, 'packages');

// Packages whose lock is known-rotted and cannot be repaired from this
// repo. A ratchet, not an excuse: shrink it, never grow it. A name here
// that has started passing is itself an error, so the list cannot quietly
// become a place for the next rot to hide.
//
// almyty-cli depends on @almyty/models and @almyty/connections at ^1.2.0
// and neither name exists on the registry — npm answers 404, so
// `npm install --package-lock-only` cannot produce a lock at all.
// Publishing those two is the fix; then delete this entry.
const CANNOT_REGENERATE = new Set(['almyty-cli']);

const problems = [];
const stale = [];
let checked = 0;

for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const dir = path.join(packagesDir, entry.name);
  const pkgPath = path.join(dir, 'package.json');
  const lockPath = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(pkgPath) || !fs.existsSync(lockPath)) continue;

  let pkg;
  let lock;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    problems.push(`${entry.name}: cannot parse manifest or lock: ${err.message}`);
    continue;
  }

  const found = [];
  const root = (lock.packages && lock.packages['']) || {};

  if (lock.name !== pkg.name) {
    found.push(`lock name is ${lock.name}, package.json says ${pkg.name}`);
  }
  if (lock.version !== pkg.version || root.version !== pkg.version) {
    found.push(
      `lock version is ${lock.version} / ${root.version}, package.json says ${pkg.version}`,
    );
  }
  for (const [field, declared] of [
    ['dependencies', pkg.dependencies],
    ['devDependencies', pkg.devDependencies],
  ]) {
    const locked = root[field] || {};
    const missing = Object.keys(declared || {}).filter((dep) => !(dep in locked));
    if (missing.length) found.push(`lock is missing ${field}: ${missing.join(', ')}`);
  }

  if (CANNOT_REGENERATE.has(entry.name)) {
    if (found.length === 0) {
      stale.push(entry.name);
    }
    continue;
  }

  checked += 1;
  for (const detail of found) problems.push(`${entry.name}: ${detail}`);
}

if (checked === 0) {
  console.error('check-package-locks: no packages with a lockfile found — wrong directory?');
  process.exit(1);
}

for (const name of stale) {
  problems.push(
    `${name}: lock now agrees with its manifest — remove it from CANNOT_REGENERATE in ${path.relative(repoRoot, __filename)}`,
  );
}

if (problems.length === 0) {
  const skipped = CANNOT_REGENERATE.size
    ? ` (${[...CANNOT_REGENERATE].join(', ')} exempt — see the note in this script)`
    : '';
  console.log(`check-package-locks: OK — ${checked} lockfiles agree with their package.json${skipped}`);
  process.exit(0);
}

console.error('check-package-locks: FAIL');
for (const problem of problems) console.error(`  ${problem}`);
if (problems.length > stale.length) {
  console.error('\n`npm ci` refuses a lock that has drifted from its manifest, so CI');
  console.error('cannot use it. Fix: cd packages/<pkg> && npm install --package-lock-only,');
  console.error('then commit the lockfile.');
}
process.exit(1);
