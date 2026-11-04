'use strict';

// node --test scripts/capture-cli-help.test.js
//
// The rendering itself needs freeze and is proven with
// `node scripts/capture-cli-help.js --from npm --verify`, which fails unless
// every image comes out byte for byte the same as the committed one. These
// tests pin the parts that decide those bytes and the manifest entry, and
// keep the list of CLIs in step with the images in the repo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { CLIS, FREEZE_ARGS, readPackage, helpText, recordArgs, staleClis } = require('./capture-cli-help.js');

const repo = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'docs-site/public/screenshots/manifest.json'), 'utf8'));
const cliShots = manifest.screenshots.filter((s) => /^screenshots\/cli\/.+-help\.png$/.test(s.path));

test('the text is the command line, then the output as printed, with HOME shown as ~', () => {
  const out = 'Usage:\n  almyty-auth login\n\nFiles:\n  /tmp/x/home/.almyty/credentials.json\n  /tmp/x/home/.almyty/config.json\n\n';
  assert.strictEqual(
    helpText('almyty-auth', out, '/tmp/x/home'),
    '$ almyty-auth --help\nUsage:\n  almyty-auth login\n\nFiles:\n  ~/.almyty/credentials.json\n  ~/.almyty/config.json\n\n',
  );
});

test('the render is freeze with window controls and no syntax highlighting', () => {
  assert.deepStrictEqual(FREEZE_ARGS, ['--window', '--language', 'text']);
});

test('every CLI help image in the manifest is one this script captures, and back', () => {
  assert.deepStrictEqual(
    cliShots.map((s) => s.path).sort(),
    CLIS.map((c) => `screenshots/cli/${c.id}-help.png`).sort(),
  );
});

test('each CLI is a package with a binary, and the manifest names that binary', () => {
  for (const cli of CLIS) {
    const pkg = readPackage(cli);
    assert.ok(pkg.bin && pkg.binPath, `packages/${cli.dir} has no bin`);
    const shot = cliShots.find((s) => s.path === `screenshots/cli/${cli.id}-help.png`);
    assert.strictEqual(shot.source.command, `${pkg.bin} --help`);
    assert.strictEqual(shot.source.package.replace(/@[^@]+$/, ''), pkg.name);
  }
});

test('registration records what was run and fingerprints the package source', () => {
  const cli = CLIS.find((c) => c.id === 'auth');
  const pkg = { name: '@almyty/auth', version: '1.5.9', bin: 'almyty-auth', binPath: 'dist/index.js' };
  const args = recordArgs(cli, pkg, '/tmp/auth-help.png', '2026-11-04T05:08:00.000Z');
  const flag = (name) => args.filter((_, i) => args[i - 1] === name);
  assert.match(args[0], /docs-site\/scripts\/record-screenshot\.mjs$/);
  assert.deepStrictEqual(flag('--path'), ['screenshots/cli/auth-help.png']);
  assert.deepStrictEqual(flag('--title'), ['Auth CLI 1.5.9 help']);
  assert.deepStrictEqual(flag('--package'), ['@almyty/auth@1.5.9']);
  assert.deepStrictEqual(flag('--command'), ['almyty-auth --help']);
  assert.deepStrictEqual(flag('--sources'), ['packages/auth-cli/src', 'packages/auth-cli/package.json']);
  assert.match(flag('--notes')[0], /published binary .*HOME set to a placeholder and normalized to ~/);
});

test('the sources recorded for each image are the ones its manifest entry fingerprints', () => {
  for (const cli of CLIS) {
    const shot = cliShots.find((s) => s.path === `screenshots/cli/${cli.id}-help.png`);
    const args = recordArgs(cli, readPackage(cli), '/tmp/x.png', '2026-11-04T00:00:00Z');
    assert.deepStrictEqual(args.filter((_, i) => args[i - 1] === '--sources'), shot.sources);
  }
});

test('--text prints the text that would be rendered, without freeze', { skip: !fs.existsSync(path.join(repo, 'packages/auth-cli/dist/index.js')) && 'auth-cli is not built' }, () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'capture-cli-help.js'), '--from', 'repo', '--only', 'auth', '--text'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\$ almyty-auth --help\n/);
  assert.doesNotMatch(r.stdout, new RegExp(require('os').tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a local build is never registered as a published capture', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'capture-cli-help.js'), '--from', 'repo', '--register'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--register needs --from npm/);
});

test('--stale picks the images whose entry names another version than package.json', () => {
  const at = (version) => ({
    screenshots: CLIS.map((c) => ({
      path: `screenshots/cli/${c.id}-help.png`,
      source: { kind: 'published-cli', package: `${readPackage(c).name}@${c.id === 'chat' ? version : readPackage(c).version}` },
    })),
  });
  assert.deepStrictEqual(staleClis(CLIS, at(readPackage(CLIS[0]).version)).map((c) => c.id), []);
  assert.deepStrictEqual(staleClis(CLIS, at('0.0.1')).map((c) => c.id), ['chat']);
  assert.deepStrictEqual(staleClis(CLIS, { screenshots: [] }).map((c) => c.id), CLIS.map((c) => c.id));
});
