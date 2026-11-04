'use strict';

// node --test scripts/check-node-version.test.js
//
// Runs check-node-version.js against a fixture with one site of each kind
// it reads: a Dockerfile, a workflow and the deployed workspaces'
// engines.node. The script resolves the repo from its own location, so it
// is copied into the fixture's scripts/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = 'check-node-version.js';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-version-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    [`scripts/${SCRIPT}`]: fs.readFileSync(path.join(__dirname, SCRIPT), 'utf8'),
    'backend/Dockerfile': 'FROM node:26-alpine AS base\nRUN npm ci\n',
    'frontend/Dockerfile': 'FROM --platform=$BUILDPLATFORM node:26-alpine AS build\nFROM nginx:1.31-alpine\n',
    '.github/workflows/ci.yml': "steps:\n  - uses: actions/setup-node@v6\n    with:\n      node-version: '26'\n",
    'package.json': JSON.stringify({ engines: { node: '>=26.0.0' } }),
    'backend/package.json': JSON.stringify({ engines: { node: '>=26' } }),
    'frontend/package.json': JSON.stringify({ engines: { node: '^26.0.0' } }),
    'docs-site/package.json': JSON.stringify({ engines: { node: '>=26' } }),
    'packages/runner/package.json': JSON.stringify({ engines: { node: '>=20' } }),
    ...overrides,
  };
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
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

test('one major everywhere passes, and packages/* keep their own floor', (t) => {
  const r = run(fixture(t));
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Node 26 across 7 declaration sites/);
});

test('a Dockerfile bumped alone fails', (t) => {
  const r = run(fixture(t, { 'backend/Dockerfile': 'FROM node:28-alpine AS base\n' }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /found 26 and 28/);
  assert.match(r.out, /backend\/Dockerfile:1 \(FROM node:28\)/);
});

test('a FROM with a --platform flag is still read', (t) => {
  const r = run(fixture(t, { 'frontend/Dockerfile': 'FROM --platform=$BUILDPLATFORM node:24-alpine AS build\n' }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /frontend\/Dockerfile:1 \(FROM node:24\)/);
});

test('a suffixed Dockerfile is read', (t) => {
  const r = run(fixture(t, { 'Dockerfile.allinone': 'FROM node:24-bookworm AS build\n' }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /Dockerfile\.allinone:1 \(FROM node:24\)/);
});

test('a workflow left on the old major fails', (t) => {
  const r = run(fixture(t, { '.github/workflows/release.yml': "      node-version: '24'\n" }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /release\.yml:1 \(node-version: 24\)/);
});

test('an engines.node on another major fails', (t) => {
  const r = run(fixture(t, { 'docs-site/package.json': JSON.stringify({ engines: { node: '>=22' } }) }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /docs-site\/package\.json \(engines\.node ">=22"\)/);
});

test('a deployed workspace with no engines.node fails', (t) => {
  const r = run(fixture(t, { 'backend/package.json': JSON.stringify({ name: 'backend' }) }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /backend\/package\.json: no engines\.node/);
});

test('Dockerfiles under node_modules are not declarations', (t) => {
  const r = run(fixture(t, { 'frontend/node_modules/some-dep/Dockerfile': 'FROM node:18-alpine\n' }));
  assert.strictEqual(r.code, 0, r.out);
});
