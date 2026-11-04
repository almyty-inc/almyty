'use strict';

// node --test scripts/check-package-locks.test.js
//
// Runs check-package-locks.js against a fixture packages/ tree. The script
// resolves the repo from its own location, so it is copied into the
// fixture's scripts/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = 'check-package-locks.js';

const manifest = {
  name: '@almyty/agents',
  version: '1.5.8',
  dependencies: { '@almyty/client': '^1.5.8', commander: '^14.0.0' },
  devDependencies: { vitest: '^4.0.0' },
};

function lockFor(pkg) {
  return {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    packages: {
      '': {
        name: pkg.name,
        version: pkg.version,
        dependencies: { ...pkg.dependencies },
        devDependencies: { ...pkg.devDependencies },
      },
    },
  };
}

function fixture(t, edit = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-locks-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, SCRIPT), path.join(root, 'scripts', SCRIPT));
  const pkg = structuredClone(manifest);
  const lock = lockFor(pkg);
  edit(pkg, lock);
  const dir = path.join(root, 'packages', 'agents-cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  if (lock) fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  return root;
}

function run(root) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', SCRIPT)], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('the repository passes', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, SCRIPT)], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('a lock that describes its manifest passes', (t) => {
  const r = run(fixture(t));
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /1 lockfiles agree/);
});

test('a version bumped in package.json but not in the lock fails', (t) => {
  const r = run(fixture(t, (pkg) => { pkg.version = '1.5.9'; }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /agents-cli: lock version is 1\.5\.8 \/ 1\.5\.8, package\.json says 1\.5\.9/);
});

test('a lock whose root entry alone kept the old version fails', (t) => {
  const r = run(fixture(t, (pkg, lock) => {
    pkg.version = '1.5.9';
    lock.version = '1.5.9';
  }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /lock version is 1\.5\.9 \/ 1\.5\.8/);
});

test('a dependency added to package.json but not to the lock fails', (t) => {
  const r = run(fixture(t, (pkg) => { pkg.dependencies.ink = '^8.0.0'; }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /lock is missing dependencies: ink/);
});

test('a devDependency missing from the lock fails', (t) => {
  const r = run(fixture(t, (pkg) => { pkg.devDependencies.typescript = '^6.0.0'; }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /lock is missing devDependencies: typescript/);
});

test('a lock for another package fails', (t) => {
  const r = run(fixture(t, (pkg, lock) => { lock.name = '@almyty/chat'; }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /lock name is @almyty\/chat, package\.json says @almyty\/agents/);
});

test('no lockfile anywhere fails rather than passing vacuously', (t) => {
  const root = fixture(t);
  fs.rmSync(path.join(root, 'packages', 'agents-cli', 'package-lock.json'));
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no packages with a lockfile found/);
});
