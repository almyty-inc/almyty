'use strict';

// node --test scripts/check-release-config.test.js
//
// Runs check-release-config.js against a copy of the files it reads, so each
// case can change one of them. The script resolves the repo from its own
// location, so it is copied into the fixture's scripts/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = 'check-release-config.js';
const repo = path.join(__dirname, '..');
const FILES = [
  '.changeset/config.json',
  'lerna.json',
  'package.json',
  '.github/workflows/publish-packages.yml',
  '.github/workflows/version-packages.yml',
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-config-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(repo, rel), path.join(root, rel));
  };
  for (const f of FILES) copy(f);
  for (const dir of fs.readdirSync(path.join(repo, 'packages'))) {
    if (fs.existsSync(path.join(repo, 'packages', dir, 'package.json'))) copy(`packages/${dir}/package.json`);
  }
  copy(`scripts/${SCRIPT}`);
  const edit = (rel, fn) => fs.writeFileSync(path.join(root, rel), fn(fs.readFileSync(path.join(root, rel), 'utf8')));
  const editJson = (rel, fn) => edit(rel, (s) => JSON.stringify(fn(JSON.parse(s)), null, 2));
  return { root, edit, editJson };
}

function run(root) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', SCRIPT)], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('the repository passes', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, SCRIPT)], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('a new publishable package missing from the release fails everywhere it is missing', (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'packages', 'new-cli'));
  fs.writeFileSync(path.join(root, 'packages', 'new-cli', 'package.json'), JSON.stringify({ name: '@almyty/new', version: '1.5.8' }));
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /config\.json: `fixed` must be one group of every publishable package/);
  assert.match(r.out, /lerna\.json: `packages` must list every publishable package directory/);
  assert.match(r.out, /publish-packages\.yml: the `package` input must offer all plus every publishable package directory/);
});

test('a private package is not part of the release', (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'packages', 'scratch'));
  fs.writeFileSync(path.join(root, 'packages', 'scratch', 'package.json'), JSON.stringify({ name: 'scratch', private: true }));
  assert.strictEqual(run(root).code, 0);
});

test('two fixed groups fail', (t) => {
  const { root, editJson } = fixture(t);
  editJson('.changeset/config.json', (c) => ({ ...c, fixed: [c.fixed[0].slice(1), c.fixed[0].slice(0, 1)] }));
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /`fixed` must be one group/);
});

test('raising internal ranges in the version PR fails', (t) => {
  const { root, editJson } = fixture(t);
  editJson('.changeset/config.json', (c) => ({ ...c, bumpVersionsWithWorkspaceProtocolOnly: false }));
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /bumpVersionsWithWorkspaceProtocolOnly must be true/);
});

test('a base branch other than development fails', (t) => {
  const { root, editJson } = fixture(t);
  editJson('.changeset/config.json', (c) => ({ ...c, baseBranch: 'master' }));
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /baseBranch must be development/);
});

test('a publish workflow without tag trigger, OIDC or provenance fails', (t) => {
  const { root, edit } = fixture(t);
  edit('.github/workflows/publish-packages.yml', (s) =>
    s.replace("tags: ['v*']", "branches: ['master']").replaceAll('id-token: write', 'id-token: none').replaceAll('--provenance', ''));
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /must publish on v\* tags/);
  assert.match(r.out, /needs `id-token: write`/);
  assert.match(r.out, /--provenance/);
});

test('a version PR that skips the lockfile sync fails', (t) => {
  const { root, edit, editJson } = fixture(t);
  edit('.github/workflows/version-packages.yml', (s) => s.replace('version-script: npm run version-packages', 'version-script: npx changeset version'));
  editJson('package.json', (p) => ({ ...p, scripts: { ...p.scripts, 'version-packages': 'changeset version' } }));
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\.version-packages must be/);
  assert.match(r.out, /version-script: npm run version-packages/);
});
