'use strict';

// node --test scripts/check-empty-values.test.js
//
// Runs check-empty-values.js against a fixture tree with one file per
// case. The script resolves the repo from its own location, so it is
// copied into the fixture's scripts/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = 'check-empty-values.js';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-values-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const all = {
    'frontend/Dockerfile': 'FROM --platform=$BUILDPLATFORM node:26-alpine AS base\nARG API_URL=\nENV X=\nEXPOSE 8080\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  // The script sits in scripts/, which is in scope, so it has to pass
  // itself. A test file there is out of scope: it is all fixtures.
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, SCRIPT), path.join(root, 'scripts', SCRIPT));
  fs.copyFileSync(__filename, path.join(root, 'scripts', path.basename(__filename)));
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

test('a clean tree passes, empty ARG/ENV defaults included', (t) => {
  const r = run(fixture(t, { 'scripts/.keep': '' }));
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /no empty slots/);
});

test('the eaten --platform value that shipped in frontend/Dockerfile fails', (t) => {
  const r = run(fixture(t, { 'frontend/Dockerfile': 'FROM --platform= node:26-alpine AS base\n' }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /frontend\/Dockerfile:1 {2}`--platform=` has no value {2}\[empty-flag-value\]/);
});

test('a flag left empty at the end of a workflow line fails', (t) => {
  const r = run(fixture(t, { '.github/workflows/ci.yml': 'run: npm audit --audit-level=\n' }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /ci\.yml:1 {2}`--audit-level=` has no value/);
});

test('an explicit empty value passes', (t) => {
  const r = run(fixture(t, { 'scripts/build.sh': 'docker build --build-arg="" --label=\'\' .\n' }));
  assert.strictEqual(r.code, 0, r.out);
});

test('an empty interpolation fails', (t) => {
  const r = run(fixture(t, { 'k8s/base/deploy.yaml': 'image: almyty/api:${}\n' }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /k8s\/base\/deploy\.yaml:1 .*\[empty-interpolation\]/);
});

test('an empty command substitution fails', (t) => {
  const r = run(fixture(t, { 'scripts/tag.sh': 'TAG=$( )\n' }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/tag\.sh:1 .*\[empty-interpolation\]/);
});

for (const [line, what] of [
  ['COPY --from= /app /app', 'COPY from an unnamed stage'],
  ['FROM node:26-alpine AS', 'a stage with no alias'],
  ['EXPOSE', 'EXPOSE with no port'],
  ['USER', 'USER with no user'],
  ['WORKDIR ', 'WORKDIR with no directory'],
]) {
  test(`${what} fails`, (t) => {
    const r = run(fixture(t, { 'backend/Dockerfile': `FROM node:26-alpine AS base\n${line}\n` }));
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /backend\/Dockerfile:2 .*\[docker-empty-slot\]/);
  });
}

test('comments that describe the shape do not fail', (t) => {
  const r = run(fixture(t, { 'backend/Dockerfile': '# never write --platform= here\nFROM node:26-alpine\n' }));
  assert.strictEqual(r.code, 0, r.out);
});

test('files outside build and deploy are out of scope', (t) => {
  const r = run(fixture(t, {
    'backend/src/cli.ts': 'run("--flag=")\n',
    'docs/notes.md': '--platform= is a bug\n',
    'frontend/node_modules/dep/Dockerfile': 'FROM --platform= node:26\n',
  }));
  assert.strictEqual(r.code, 0, r.out);
});
