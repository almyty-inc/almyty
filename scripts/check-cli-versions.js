#!/usr/bin/env node
// Self-reported version gate for the @almyty/* CLI suite.
//
// check-npm-lockstep.js proves the manifests agree with each other. This
// proves each CLI's *binary* agrees with its own manifest, which is a
// different thing and the one users actually see. Every CLI in the suite
// once restated its version as a literal, and they drifted: the published
// @almyty/cli@1.2.0 answers --version with 0.1.0. A literal does not move
// when the publish workflow bumps package.json, so the lie survives every
// release and no bug report can name the build it came from.
//
// Three checks, in order of how early they catch the mistake:
//
//   1. No exported *VERSION constant is a hardcoded semver. That is the
//      defect itself, and it fails on the commit that reintroduces it.
//
//   2. The module that reads package.json resolves it correctly FROM THE
//      BUILT LAYOUT, not from src/. The URL form used here is only right
//      for a module one level below the package root; move it to
//      src/lib/version.ts and the built dist/lib/version.js reads a
//      package.json that is not there, so the CLI silently reports its
//      0.0.0 fallback forever. The depth is checked against the literal
//      path, so the two cannot disagree.
//
//   3. When dist/ exists, actually run the built binary and compare what
//      it prints to package.json. This is the only check that proves the
//      whole chain end to end, so it runs whenever a build is present and
//      says plainly which packages it had to skip.
//
// No dependencies - just Node's fs + child_process. Exits 0 when every
// CLI reports its own version, 1 with a report otherwise.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const packagesDir = path.join(repoRoot, 'packages');

const SEMVER = /^\d+\.\d+\.\d+/;
const HARDCODED =
  /export\s+const\s+([A-Za-z_][A-Za-z0-9_]*(?:VERSION|Version))\s*(?::\s*string\s*)?=\s*['"]([^'"]+)['"]/g;
const PKG_READ = /new URL\(\s*['"]([^'"]*package\.json)['"]\s*,\s*import\.meta\.url\s*\)/g;

const problems = [];
const notes = [];
let checkedPackages = 0;
let ranBinaries = 0;

const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', 'test', 'tests']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
      continue;
    }
    if (!/\.(ts|tsx|js|mjs)$/.test(e.name)) continue;
    if (/\.(spec|test)\./.test(e.name)) continue;
    out.push(p);
  }
  return out;
}

for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const dir = path.join(packagesDir, entry.name);
  const pkgPath = path.join(dir, 'package.json');
  const srcDir = path.join(dir, 'src');
  if (!fs.existsSync(pkgPath)) continue;
  if (!fs.existsSync(srcDir)) continue;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    problems.push(entry.name + ': cannot parse package.json: ' + err.message);
    continue;
  }
  if (pkg.private) continue;
  // Only a package that ships a binary reports a version to a user.
  if (!pkg.bin) continue;
  if (Object.keys(pkg.bin).length === 0) continue;

  checkedPackages += 1;
  let readsPackageJson = false;

  for (const file of walk(srcDir, [])) {
    const rel = path.relative(dir, file);
    const source = fs.readFileSync(file, 'utf8');

    for (const m of source.matchAll(HARDCODED)) {
      if (!SEMVER.test(m[2])) continue;
      problems.push(
        entry.name +
          ': ' +
          rel +
          ' hardcodes ' +
          m[1] +
          " = '" +
          m[2] +
          "' - read it from package.json instead (package.json says " +
          pkg.version +
          ')',
      );
    }

    for (const m of source.matchAll(PKG_READ)) {
      readsPackageJson = true;
      // tsc strips the src/ prefix, so src/version.ts builds to
      // dist/version.js and src/lib/version.ts to dist/lib/version.js.
      // What the relative path has to clear is therefore the depth below
      // src/, plus the dist/ directory itself -- not the depth below the
      // package root, which would count src/ twice.
      const depthBelowSrc = path.relative(srcDir, file).split(path.sep).length - 1;
      const expected = '../'.repeat(depthBelowSrc + 1) + 'package.json';
      if (m[1] === expected) continue;
      problems.push(
        entry.name +
          ': ' +
          rel +
          " reads '" +
          m[1] +
          "' but sits " +
          (depthBelowSrc + 1) +
          ' level(s) below the package root once built, so the built copy' +
          " resolves a package.json that is not there. Expected '" +
          expected +
          "'.",
      );
    }
  }

  if (!readsPackageJson) {
    problems.push(
      entry.name +
        ': no module under src/ reads its package.json, so whatever it reports as' +
        ' its version cannot track the ' +
        pkg.version +
        ' in package.json',
    );
  }

  const binRel = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
  const binPath = path.join(dir, binRel);
  if (!fs.existsSync(binPath)) {
    notes.push(entry.name + ': dist not built, skipped the live version check');
    continue;
  }

  let reported = null;
  for (const argv of [['--version'], ['version']]) {
    const run = spawnSync(process.execPath, [binPath].concat(argv), {
      encoding: 'utf8',
      timeout: 30000,
      env: Object.assign({}, process.env, { NO_COLOR: '1' }),
    });
    const lines = String(run.stdout == null ? '' : run.stdout)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const hit = lines.find((l) => SEMVER.test(l));
    if (hit) {
      reported = hit;
      break;
    }
  }

  if (reported === null) {
    problems.push(entry.name + ': ' + binRel + ' printed no version for --version or version');
    continue;
  }

  ranBinaries += 1;
  if (reported !== pkg.version) {
    problems.push(
      entry.name + ': ' + binRel + ' reports ' + reported + ', package.json says ' + pkg.version,
    );
  }
}

if (checkedPackages === 0) {
  console.error('check-cli-versions: no publishable CLI packages found - wrong directory?');
  process.exit(1);
}

if (problems.length === 0) {
  console.log(
    'check-cli-versions: OK - ' +
      checkedPackages +
      ' CLIs read their version from package.json (' +
      ranBinaries +
      ' verified by running the built binary)',
  );
  for (const note of notes) console.log('  note: ' + note);
  process.exit(0);
}

console.error('check-cli-versions: FAIL');
for (const problem of problems) console.error('  ' + problem);
console.error('');
console.error('A version literal in source does not move when the publish workflow bumps');
console.error('package.json, so --version and every --help banner start lying at the next');
console.error('release. Fix: export it from a src/version.ts that reads package.json with');
console.error("new URL('../package.json', import.meta.url), and import that.");
process.exit(1);
