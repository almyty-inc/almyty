'use strict';

// node --test scripts/check-npm-lockstep.test.js
//
// Runs check-npm-lockstep.js against a fixture packages/ tree. The script
// resolves the repo from its own location, so it is copied into the
// fixture's scripts/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = 'check-npm-lockstep.js';

function fixture(t, packages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-lockstep-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, SCRIPT), path.join(root, 'scripts', SCRIPT));
  fs.mkdirSync(path.join(root, 'packages'));
  for (const [dir, manifest] of Object.entries(packages)) {
    fs.mkdirSync(path.join(root, 'packages', dir));
    const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    fs.writeFileSync(path.join(root, 'packages', dir, 'package.json'), body);
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

test('packages at one version pass', (t) => {
  const r = run(fixture(t, {
    client: { name: '@almyty/client', version: '1.5.8' },
    'agents-cli': { name: '@almyty/agents', version: '1.5.8' },
  }));
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /all 2 publishable @almyty\/\* packages at 1\.5\.8/);
});

test('one package on another version fails and is named', (t) => {
  const r = run(fixture(t, {
    client: { name: '@almyty/client', version: '1.5.8' },
    'agents-cli': { name: '@almyty/agents', version: '1.5.8' },
    'chat-cli': { name: '@almyty/chat', version: '1.5.9' },
  }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /1\.5\.9\t@almyty\/chat/);
  assert.match(r.out, /Found 2 distinct versions/);
});

test('a private package is not held to the lockstep', (t) => {
  const r = run(fixture(t, {
    client: { name: '@almyty/client', version: '1.5.8' },
    'cli-tests': { name: '@almyty/cli-tests', version: '0.0.0', private: true },
  }));
  assert.strictEqual(r.code, 0, r.out);
});

test('no publishable package at all fails', (t) => {
  const r = run(fixture(t, { 'cli-tests': { name: 'cli-tests', version: '0.0.0', private: true } }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no publishable packages found/);
});

test('an unreadable manifest fails', (t) => {
  const r = run(fixture(t, { client: '{ not json' }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /cannot parse/);
});
