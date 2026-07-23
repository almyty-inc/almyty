#!/usr/bin/env node
// Lockstep version gate for the @almyty/* npm CLI suite.
//
// Every publishable package under packages/* ships in lockstep: they all
// carry the identical version so a user who installs @almyty/cli@x.y.z gets
// dependents at the same x.y.z. This script fails CI if that invariant is
// broken. Packages marked "private": true (e.g. cli-tests) are never
// published and are ignored.
//
// No dependencies — just Node's fs. Exits 0 when all versions match,
// 1 with a mismatch report otherwise.

'use strict';

const fs = require('fs');
const path = require('path');

const packagesDir = path.join(__dirname, '..', 'packages');

let entries;
try {
  entries = fs.readdirSync(packagesDir, { withFileTypes: true });
} catch (err) {
  console.error(`check-npm-lockstep: cannot read ${packagesDir}: ${err.message}`);
  process.exit(1);
}

const publishable = [];

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const pkgPath = path.join(packagesDir, entry.name, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    console.error(`check-npm-lockstep: cannot parse ${pkgPath}: ${err.message}`);
    process.exit(1);
  }

  if (pkg.private === true) continue; // never published, skip

  publishable.push({
    name: pkg.name || entry.name,
    version: pkg.version,
    path: path.relative(path.join(__dirname, '..'), pkgPath),
  });
}

if (publishable.length === 0) {
  console.error('check-npm-lockstep: no publishable packages found');
  process.exit(1);
}

const versions = new Set(publishable.map((p) => p.version));

if (versions.size === 1) {
  const [version] = [...versions];
  console.log(
    `check-npm-lockstep: OK — all ${publishable.length} publishable @almyty/* packages at ${version}`,
  );
  process.exit(0);
}

console.error('check-npm-lockstep: FAIL — publishable @almyty/* package versions are not in lockstep:');
for (const p of publishable.sort((a, b) => a.name.localeCompare(b.name))) {
  console.error(`  ${p.version}\t${p.name}\t(${p.path})`);
}
console.error(`\nFound ${versions.size} distinct versions; expected exactly 1.`);
console.error('Bump every publishable package to the same version before merging.');
process.exit(1);
