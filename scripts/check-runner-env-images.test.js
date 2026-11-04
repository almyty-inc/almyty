'use strict';

// node --test scripts/check-runner-env-images.test.js
//
// Runs check-runner-env-images.js against a copy of the files it reads, so
// each case can change one of them. The script resolves the repo from its
// own location, so it is copied into the fixture's scripts/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..');
const FILES = [
  'images/runner-env/Dockerfile',
  'images/runner-env/settings.json',
  'images/runner-env/entrypoint.sh',
  'packages/runner/package.json',
  'backend/src/modules/hosted-runners/hosted-runner-settings.ts',
  'docs/design/hosted-runners/image-prepull.yaml',
  '.github/workflows/runner-env-images.yml',
];
const DIGEST = (c) => `@sha256:${c.repeat(64)}`;
const FLAVOURS = ['standard', 'standard-browser', 'node', 'python'];

function fixture({ dockerVersion, runnerVersion, ref }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-env-check-'));
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(repo, f), path.join(root, f));
  }
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, 'check-runner-env-images.js'), path.join(root, 'scripts', 'check-runner-env-images.js'));

  const edit = (f, fn) => fs.writeFileSync(path.join(root, f), fn(fs.readFileSync(path.join(root, f), 'utf8')));
  edit('images/runner-env/Dockerfile', (s) => s.replace(/^ARG RUNNER_VERSION=\S+$/m, `ARG RUNNER_VERSION=${dockerVersion}`));
  edit('packages/runner/package.json', (s) => JSON.stringify({ ...JSON.parse(s), version: runnerVersion || dockerVersion }));

  const images = Object.fromEntries(FLAVOURS.map((name) => [name, ref(name)]));
  edit('images/runner-env/settings.json', () => JSON.stringify({ images }, null, 2));
  const imagesBlock = /(DEFAULT_HOSTED_RUNNER_SETTINGS[\s\S]*?\n\s*images:\s*\{)[\s\S]*?(\})/;
  edit('backend/src/modules/hosted-runners/hosted-runner-settings.ts', (s) =>
    s.replace(imagesBlock, `$1\n    standard: '${images.standard}',\n    'standard-browser': '${images['standard-browser']}',\n  $2`));
  edit('docs/design/hosted-runners/image-prepull.yaml', (s) =>
    s.replace(/^(\s*image:\s*)almyty\/runner-env:standard\S*$/m, `$1${images.standard}`));
  return { root, edit };
}

function run(root) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-runner-env-images.js')], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('the repository passes', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'check-runner-env-images.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('pinned references may trail the Dockerfile version', () => {
  const { root } = fixture({ dockerVersion: '1.5.8', ref: (n) => `almyty/runner-env:${n}-1.5.7${DIGEST('a')}` });
  const r = run(root);
  assert.strictEqual(r.code, 0, r.out);
});

test('pinned references at the Dockerfile version pass', () => {
  const { root } = fixture({ dockerVersion: '1.5.8', ref: (n) => `almyty/runner-env:${n}-1.5.8${DIGEST('b')}` });
  const r = run(root);
  assert.strictEqual(r.code, 0, r.out);
});

test('an unpinned tag fails, even at the Dockerfile version', () => {
  const { root } = fixture({ dockerVersion: '1.5.8', ref: (n) => `almyty/runner-env:${n}-1.5.8` });
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no @sha256: digest/);
});

test('a reference newer than the Dockerfile version fails', () => {
  const { root } = fixture({ dockerVersion: '1.5.8', runnerVersion: '1.6.0', ref: (n) => `almyty/runner-env:${n}-1.5.9${DIGEST('c')}` });
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /names runner 1\.5\.9, newer than the Dockerfile's RUNNER_VERSION 1\.5\.8/);
});

test('a reference for another flavour fails', () => {
  const { root, edit } = fixture({ dockerVersion: '1.5.8', ref: (n) => `almyty/runner-env:${n}-1.5.7${DIGEST('d')}` });
  edit('images/runner-env/settings.json', (s) => s.replace('runner-env:node-1.5.7', 'runner-env:python-1.5.7'));
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /settings\.json: "node" is almyty\/runner-env:python-1\.5\.7/);
});

test('an unpinned pre-pull image fails', () => {
  const { root, edit } = fixture({ dockerVersion: '1.5.8', ref: (n) => `almyty/runner-env:${n}-1.5.7${DIGEST('e')}` });
  edit('docs/design/hosted-runners/image-prepull.yaml', (s) =>
    s.replace(/^(\s*image:\s*)almyty\/runner-env:standard\S*$/m, '$1almyty/runner-env:standard-1.5.8'));
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /image-prepull\.yaml: "standard" is almyty\/runner-env:standard-1\.5\.8 with no @sha256: digest/);
});

test('a backend default that differs from settings.json fails', () => {
  const { root, edit } = fixture({ dockerVersion: '1.5.8', ref: (n) => `almyty/runner-env:${n}-1.5.7${DIGEST('f')}` });
  edit('backend/src/modules/hosted-runners/hosted-runner-settings.ts', (s) =>
    s.replace(`standard: 'almyty/runner-env:standard-1.5.7${DIGEST('f')}'`, `standard: 'almyty/runner-env:standard-1.5.6${DIGEST('f')}'`));
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /default image "standard" is .*; settings\.json says/);
});

test('a Dockerfile pin behind packages/runner fails: the images carry the in-repo runner', () => {
  const { root } = fixture({ dockerVersion: '1.5.8', runnerVersion: '1.5.9', ref: (n) => `almyty/runner-env:${n}-1.5.8${DIGEST('1')}` });
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /Dockerfile pins @almyty\/runner 1\.5\.8, but packages\/runner is 1\.5\.9/);
});

test('a push job that builds without the in-repo runner fails', () => {
  const { root, edit } = fixture({ dockerVersion: '1.5.8', ref: (n) => `almyty/runner-env:${n}-1.5.7${DIGEST('2')}` });
  edit('.github/workflows/runner-env-images.yml', (s) => {
    const at = s.lastIndexOf('build-contexts: runner-pkg=');
    return s.slice(0, at) + s.slice(at).replace(/^.*build-contexts: runner-pkg=.*\n/m, '');
  });
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /the build and the push job must each build with the `runner-pkg` context .*\(found 1\)/);
});

test('a push job that pushes without a smoke test fails', () => {
  const { root, edit } = fixture({ dockerVersion: '1.5.8', ref: (n) => `almyty/runner-env:${n}-1.5.7${DIGEST('3')}` });
  edit('.github/workflows/runner-env-images.yml', (s) => {
    const at = s.lastIndexOf('images/runner-env/smoke.sh');
    return s.slice(0, at) + s.slice(at).replace(/^.*images\/runner-env\/smoke\.sh.*\n/m, '');
  });
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /must each run images\/runner-env\/smoke\.sh \(found 1\)/);
});
