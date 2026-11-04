'use strict';

// node --test scripts/check-cli-versions.test.js
//
// Runs check-cli-versions.js against a fixture CLI package. The script
// resolves the repo from its own location, so it is copied into the
// fixture's scripts/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = 'check-cli-versions.js';
const READS_PKG = "export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;\n";

// A built binary that prints the version it is given.
const bin = (version) => `#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log(${JSON.stringify(version)});\n`;

function fixture(t, { files = { 'src/version.ts': READS_PKG }, manifest = {}, built } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-versions-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, SCRIPT), path.join(root, 'scripts', SCRIPT));
  const dir = path.join(root, 'packages', 'agents-cli');
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  write('package.json', JSON.stringify({
    name: '@almyty/agents', version: '1.5.8', bin: { 'almyty-agents': 'dist/index.js' }, ...manifest,
  }));
  write('src/index.ts', "import { VERSION } from './version.js';\n");
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  if (built !== undefined) write('dist/index.js', bin(built));
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

test('a CLI that reads its package.json passes, and says when it had no build to run', (t) => {
  const r = run(fixture(t));
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /1 CLIs read their version from package\.json \(0 verified/);
  assert.match(r.out, /agents-cli: dist not built, skipped the live version check/);
});

test('a hardcoded version constant fails', (t) => {
  const r = run(fixture(t, { files: {
    'src/version.ts': READS_PKG,
    'src/banner.ts': "export const CLI_VERSION = '0.1.0';\n",
  } }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /src\/banner\.ts hardcodes CLI_VERSION = '0\.1\.0'/);
});

test('a version constant that is not semver is not mistaken for one', (t) => {
  const r = run(fixture(t, { files: {
    'src/version.ts': READS_PKG,
    'src/protocol.ts': "export const PROTOCOL_VERSION = 'latest';\n",
  } }));
  assert.strictEqual(r.code, 0, r.out);
});

test('a reader one level deeper with the shallow path fails', (t) => {
  const r = run(fixture(t, { files: { 'src/lib/version.ts': READS_PKG } }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /src\/lib\/version\.ts reads '\.\.\/package\.json' but sits 2 level\(s\) below .* Expected '\.\.\/\.\.\/package\.json'/);
});

test('a reader one level deeper with the matching path passes', (t) => {
  const r = run(fixture(t, { files: { 'src/lib/version.ts': READS_PKG.replace('../package.json', '../../package.json') } }));
  assert.strictEqual(r.code, 0, r.out);
});

test('a CLI that never reads its package.json fails', (t) => {
  const r = run(fixture(t, { files: { 'src/version.ts': 'export const VERSION = process.env.V;\n' } }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no module under src\/ reads its package\.json/);
});

test('a built binary that reports its package.json version passes', (t) => {
  const r = run(fixture(t, { built: '1.5.8' }));
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\(1 verified by running the built binary\)/);
});

test('a built binary that reports another version fails', (t) => {
  const r = run(fixture(t, { built: '0.1.0' }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /dist\/index\.js reports 0\.1\.0, package\.json says 1\.5\.8/);
});

test('a built binary that prints no version fails', (t) => {
  const r = run(fixture(t, { built: 'usage: almyty-agents' }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /printed no version/);
});

test('packages without a bin, or private ones, are not CLIs to check', (t) => {
  const root = fixture(t, { manifest: { private: true } });
  const r = run(root);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no publishable CLI packages found/);
});
