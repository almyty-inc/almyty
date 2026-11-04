'use strict';

// node --test scripts/npm-audit-retry.test.js
//
// Runs npm-audit-retry.sh with a fake `npm` first on PATH. Each call the
// fake makes prints the next scripted reply and exits with its code, and
// records its arguments, so a case can say exactly how many audits ran.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'npm-audit-retry.sh');

const FAKE_NPM = `#!/usr/bin/env bash
n=$(( $(cat "$FAKE_DIR/calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE_DIR/calls"
printf '%s\\n' "$*" >> "$FAKE_DIR/argv"
reply="$FAKE_DIR/reply.$n"
[ -f "$reply.out" ] || reply="$FAKE_DIR/reply.last"
cat "$reply.out"
exit "$(cat "$reply.code")"
`;

const FINDING = '# npm audit report\n\nlodash  <4.17.21\nSeverity: high\n\n1 high severity vulnerability\n';
const OUTAGE = 'npm error audit endpoint returned an error\nnpm error code E500';

// replies: [[output, exitCode], ...]; the last one repeats.
function run(t, replies, { args = ['--audit-level=high', '--omit=dev'], attempts } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-audit-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'npm'), FAKE_NPM, { mode: 0o755 });
  replies.forEach(([out, code], i) => {
    for (const name of [`reply.${i + 1}`, ...(i === replies.length - 1 ? ['reply.last'] : [])]) {
      fs.writeFileSync(path.join(dir, `${name}.out`), out);
      fs.writeFileSync(path.join(dir, `${name}.code`), String(code));
    }
  });
  const env = {
    ...process.env,
    PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`,
    FAKE_DIR: dir,
    NPM_AUDIT_BACKOFF_SECONDS: '0',
    ...(attempts ? { NPM_AUDIT_ATTEMPTS: String(attempts) } : {}),
  };
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env });
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  return {
    code: r.status,
    out: r.stdout + r.stderr,
    calls: Number(read('calls') || 0),
    argv: read('argv').trim().split('\n'),
  };
}

test('a clean audit passes after one run, with the arguments passed through', (t) => {
  const r = run(t, [['found 0 vulnerabilities', 0]]);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.calls, 1);
  assert.deepStrictEqual(r.argv, ['audit --audit-level=high --omit=dev']);
  assert.match(r.out, /found 0 vulnerabilities/);
});

test('a real finding fails at once and is not retried', (t) => {
  const r = run(t, [[FINDING, 1], ['found 0 vulnerabilities', 0]]);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.calls, 1);
  assert.match(r.out, /1 high severity vulnerability/);
  assert.doesNotMatch(r.out, /retrying/);
});

test('a non-1 failure that is not a transport error keeps its exit code', (t) => {
  const r = run(t, [['npm error code ENOLOCK\nnpm error audit This command requires an existing lockfile.', 1]]);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.calls, 1);
});

test('an outage is retried until the audit runs', (t) => {
  const r = run(t, [[OUTAGE, 1], [OUTAGE, 1], ['found 0 vulnerabilities', 0]]);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.calls, 3);
  assert.match(r.out, /::warning::npm audit could not reach the registry advisory endpoint \(attempt 1\/4\)/);
});

test('a finding after an outage still fails', (t) => {
  const r = run(t, [[OUTAGE, 1], [FINDING, 1]]);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.calls, 2);
});

test('an outage that never clears fails after the configured attempts', (t) => {
  const r = run(t, [[OUTAGE, 1]], { attempts: 3 });
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.calls, 3);
  assert.match(r.out, /::error::npm audit failed to reach the registry advisory endpoint after 3 attempts/);
});

for (const transport of [
  'npm error network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
  'npm error code ECONNRESET',
  'npm error code ETIMEDOUT',
  'npm error code EAI_AGAIN',
  'npm error 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
  'npm error 502 Bad Gateway - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
]) {
  test(`"${transport.slice(10, 40)}..." counts as an outage`, (t) => {
    const r = run(t, [[transport, 1], ['found 0 vulnerabilities', 0]]);
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(r.calls, 2);
  });
}
