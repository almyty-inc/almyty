'use strict';

// node --test scripts/wait-for-npm.test.js
//
// Runs scripts/wait-for-npm.js against a fake `npm` first on PATH, which
// serves the versions the test says it does: all of them at once, one only
// from its third lookup, or one never.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { released, waitForNpm } = require('./wait-for-npm.js');

const script = path.join(__dirname, 'wait-for-npm.js');
const packages = released();
const runner = packages.find((p) => p.name === '@almyty/runner');

// FAKE_NPM_LATE="<name>:<n>" serves <name> from its n-th lookup on;
// FAKE_NPM_NEVER="<name>" never serves it. Every lookup is appended to
// $FAKE_NPM_DIR/calls, and one without --prefer-online fails.
const FAKE_NPM = `#!/bin/sh
if [ "$1" != view ] || [ "$3" != version ] || [ "$4" != --prefer-online ]; then
  echo "fake npm: unexpected $*" >&2
  exit 2
fi
spec=$2
name=\${spec%@*}
echo "$spec" >> "$FAKE_NPM_DIR/calls"
seen=$(grep -cxF "$spec" "$FAKE_NPM_DIR/calls")
if [ "$FAKE_NPM_NEVER" = "$name" ]; then
  echo "npm error code E404" >&2
  exit 1
fi
if [ -n "$FAKE_NPM_LATE" ] && [ "\${FAKE_NPM_LATE%:*}" = "$name" ] && [ "$seen" -lt "\${FAKE_NPM_LATE##*:}" ]; then
  echo "npm error code E404" >&2
  exit 1
fi
echo "\${spec##*@}"
`;

function run(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-for-npm-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });
  try {
    const r = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
        FAKE_NPM_DIR: dir,
        WAIT_FOR_NPM_TIMEOUT_SECONDS: '5',
        WAIT_FOR_NPM_INTERVAL_SECONDS: '0.01',
        WAIT_FOR_NPM_MAX_INTERVAL_SECONDS: '0.05',
        ...env,
      },
    });
    const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');
    return { ...r, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('reads every publishable @almyty/* package and its version from the repo', () => {
  assert.strictEqual(packages.length, 12);
  for (const p of packages) {
    assert.match(p.name, /^@almyty\//);
    assert.match(p.version, /^\d+\.\d+\.\d+/);
  }
  assert.ok(runner, '@almyty/runner is publishable');
});

test('exits 0 at once when npm serves every version', () => {
  const r = run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.calls.length, packages.length);
  assert.deepStrictEqual(new Set(r.calls), new Set(packages.map((p) => `${p.name}@${p.version}`)));
  assert.match(r.stdout, /npm serves all 12/);
});

test('keeps polling a version npm serves late, and only that one', () => {
  const r = run({ FAKE_NPM_LATE: `${runner.name}:3` });
  assert.strictEqual(r.status, 0, r.stderr);
  const spec = `${runner.name}@${runner.version}`;
  assert.strictEqual(r.calls.filter((c) => c === spec).length, 3);
  assert.strictEqual(r.calls.length, packages.length + 2);
  assert.match(r.stdout, new RegExp(`does not serve ${spec.replace(/[.^]/g, '\\$&')} yet`));
});

test('fails naming the package npm never serves', () => {
  const r = run({ FAKE_NPM_NEVER: runner.name, WAIT_FOR_NPM_TIMEOUT_SECONDS: '0.3' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, new RegExp(`npm still does not serve ${runner.name}@${runner.version.replace(/\./g, '\\.')} after 0\\.3s`));
  assert.doesNotMatch(r.stderr, /@almyty\/client@/);
});

test('backs off up to the cap and stops at the deadline', async () => {
  let clock = 0;
  const pauses = [];
  const missing = await waitForNpm([{ name: 'a', version: '1.0.0' }], {
    serves: () => false,
    timeoutMs: 20 * 60 * 1000,
    now: () => clock,
    sleep: async (ms) => { pauses.push(ms); clock += ms; },
    log: () => {},
  });
  assert.deepStrictEqual(missing, [{ name: 'a', version: '1.0.0' }]);
  assert.deepStrictEqual(pauses.slice(0, 6), [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.strictEqual(pauses.reduce((a, b) => a + b, 0), 20 * 60 * 1000);
});

test('post-release.yml waits for npm before anything installs from it', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'post-release.yml'), 'utf8');
  const wait = wf.indexOf('node scripts/wait-for-npm.js');
  assert.ok(wait !== -1, 'post-release.yml does not run scripts/wait-for-npm.js');
  for (const install of ['node scripts/release-packages.js raise-ranges', 'node scripts/capture-cli-help.js']) {
    const at = wf.indexOf(install);
    assert.ok(at !== -1, `post-release.yml no longer runs ${install}`);
    assert.ok(wait < at, `${install} runs before the wait for npm`);
  }
});
