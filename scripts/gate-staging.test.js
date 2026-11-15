'use strict';

// node --test scripts/gate-staging.test.js
//
// The staging gate's report: rows read from Playwright's and vitest's JSON
// reports, and the table built from them. The run itself needs staging
// and the QA user, so it is not exercised here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { playwrightRows, vitestRows, buildReport, firstLine, redact, readLocalPackages, buildOrder, installNeeded, writeInstallStamp } = require('./gate-staging');

const playwrightReport = {
  suites: [
    {
      title: 'j3-openapi.spec.ts',
      specs: [],
      suites: [
        {
          title: 'J3 connect an API by OpenAPI link',
          specs: [
            {
              title: 'J3 Test tool returns real forecast data, and a 4xx shows Error',
              tests: [{ status: 'expected', annotations: [], results: [{ status: 'passed', duration: 18000, annotations: [{ type: 'screenshot', description: '/repo/gate-results/shots/a.png' }], attachments: [] }] }],
            },
            {
              title: 'J3 GraphQL import (Countries) and run a query tool',
              tests: [{ status: 'unexpected', annotations: [], results: [{ status: 'failed', duration: 9000, error: { message: '\u001b[31mError: the country query should succeed\u001b[39m\n\nExpected: "Success"' }, attachments: [{ name: 'screenshot', path: '/repo/gate-results/playwright/x/test-failed-1.png' }], annotations: [{ type: 'cleanup', description: 'delete api 1: 500' }] }] }],
            },
            {
              title: 'J3 timed out',
              tests: [{ status: 'unexpected', annotations: [], results: [{ status: 'timedOut', duration: 300000, errors: [{ message: 'Test timeout of 300000ms exceeded.' }], attachments: [] }] }],
            },
          ],
        },
      ],
    },
  ],
};

test('playwrightRows reads status, suite, screenshot, error and cleanup', () => {
  const rows = playwrightRows(playwrightReport);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], {
    suite: 'J3 connect an API by OpenAPI link',
    title: 'J3 Test tool returns real forecast data, and a 4xx shows Error',
    status: 'passed',
    ms: 18000,
    screenshot: '/repo/gate-results/shots/a.png',
    error: '',
    cleanup: '',
  });
  assert.strictEqual(rows[1].status, 'failed');
  assert.strictEqual(rows[1].error, 'Error: the country query should succeed');
  assert.strictEqual(rows[1].screenshot, '/repo/gate-results/playwright/x/test-failed-1.png');
  assert.strictEqual(rows[1].cleanup, 'delete api 1: 500');
  // A timeout is a failure, with Playwright's own message.
  assert.strictEqual(rows[2].status, 'failed');
  assert.match(rows[2].error, /timeout/);
});

test('vitestRows reads passed, failed and skipped tests', () => {
  const rows = vitestRows({
    testResults: [{
      assertionResults: [
        { ancestorTitles: ['core CLI', 'auth'], title: 'whoami', status: 'passed', duration: 120, failureMessages: [] },
        { ancestorTitles: ['chat-cli'], title: 'one-shot', status: 'failed', duration: 900, failureMessages: ['AssertionError: expected 1 to be 0\n at x'] },
        { ancestorTitles: ['chat-cli'], title: 'later', status: 'pending', failureMessages: [] },
      ],
    }],
  });
  assert.deepStrictEqual(rows.map((r) => [r.suite, r.title, r.status]), [
    ['core CLI › auth', 'whoami', 'passed'],
    ['chat-cli', 'one-shot', 'failed'],
    ['chat-cli', 'later', 'skipped'],
  ]);
  assert.strictEqual(rows[1].error, 'AssertionError: expected 1 to be 0');
});

test('buildReport: a failing test with a recorded finding shows the root cause; a fixed one says so', () => {
  const browser = playwrightRows(playwrightReport);
  const md = buildReport({
    runId: '261113140000',
    startedAt: 's',
    finishedAt: 'f',
    target: { app: 'https://app', api: 'https://api' },
    health: { status: 'passed', ms: 50 },
    browser,
    cli: [{ suite: 'login', title: 'almyty login', status: 'passed', ms: 0, screenshot: '', error: '' }],
    findings: {
      'J3 GraphQL import (Countries) and run a query tool': { finding: 'No query is sent.', rootCause: 'graphql-parser.service.ts:110' },
      'J3 Test tool returns real forecast data, and a 4xx shows Error': { finding: 'Errors showed as Success.', rootCause: 'api.ts:149' },
    },
  });
  assert.match(md, /Result: \*\*FAIL\*\* — 3 passed, 2 failed, 0 skipped/);
  assert.match(md, /\| GET \/health\/ready \| PASS \|/);
  assert.match(md, /FINDING: No query is sent\. Root cause: graphql-parser\.service\.ts:110/);
  assert.match(md, /recorded finding no longer reproduces: Errors showed as Success\./);
  assert.match(md, /\[cleanup left: delete api 1: 500\]/);
  assert.match(md, /\| CLI login \| almyty login \| PASS \|/);
  // Without a finding, the failure's own first line is shown.
  assert.match(md, /Test timeout of 300000ms exceeded\./);
});

test('every recorded finding names a file and line', () => {
  const findings = JSON.parse(fs.readFileSync(path.join(__dirname, 'gate-findings.json'), 'utf8'));
  for (const [title, f] of Object.entries(findings)) {
    assert.ok(f.finding, `${title}: finding`);
    assert.match(f.rootCause, /[\w/.-]+\.(ts|tsx|js):\d+/, `${title}: root cause must cite file:line`);
  }
});

test('firstLine strips colour codes and blank lines', () => {
  assert.strictEqual(firstLine('\n\u001b[2mexpect(x)\u001b[22m\nmore'), 'expect(x)');
});

test('the report never carries a session cookie, JWT or almyty API key', () => {
  // Synthetic values, assembled at run time so no scanner mistakes them for
  // real ones: a JWT-shaped token and a key in the almyty_ + 64 hex format.
  const fakeJwt = ['eyJ', 'fake'.repeat(4), '.', 'part'.repeat(4), '.', 'sig'.repeat(4)].join('');
  const fakeKey = 'almyty_' + 'ab'.repeat(32);
  const leak = `DELETE /apis/1 cookie: access_token=${fakeJwt} and ${fakeKey}`;
  const md = buildReport({
    runId: 'r', startedAt: 's', finishedAt: 'f', target: { app: 'a', api: 'b' }, health: null,
    browser: [{ suite: 's', title: 't', status: 'failed', ms: 1, screenshot: '', error: leak, cleanup: leak }],
    cli: [],
  });
  assert.doesNotMatch(md, /eyJ|almyty_abab/);
  assert.match(md, /<redacted>/);
  assert.strictEqual(redact('Bearer abc.def'), 'Bearer <redacted>');
});
// The CLI phase failed with "Cannot find module '@almyty/client'": it built
// the CLIs but not packages/client, which they import.
test('the CLI packages build after the local packages they import, @almyty/client before its users', () => {
  const pkgs = readLocalPackages(path.join(__dirname, '..', 'packages'));
  const cli = ['auth-cli', 'agents-cli', 'chat-cli', 'skills-cli', 'mcp-server', 'models-cli', 'credentials-cli', 'almyty-cli'];
  const roots = cli.map((d) => Object.values(pkgs).find((p) => path.basename(p.dir) === d).name);
  const order = buildOrder(pkgs, roots);
  assert.ok(order.indexOf('@almyty/client') >= 0 && order.indexOf('@almyty/client') < order.indexOf('@almyty/agents'));
  for (const name of order) {
    for (const dep of pkgs[name].localDeps) {
      assert.ok(order.indexOf(dep) < order.indexOf(name), `${dep} builds before ${name}`);
    }
  }
  assert.ok(pkgs['@almyty/agents'].localDeps.includes('@almyty/client'));
  for (const r of roots) assert.ok(order.includes(r), `${r} is built`);
});

test('buildOrder refuses a dependency cycle', () => {
  const pkgs = { a: { localDeps: ['b'] }, b: { localDeps: ['a'] } };
  assert.throws(() => buildOrder(pkgs, ['a']), /dependency cycle: a -> b -> a/);
});

// ── secrets out of the terminal, the report and the files left behind ──
//
// Playwright's error for a failed request lists its headers, and the gate
// printed it straight to the terminal: the QA user's access_token cookie
// with it. Fake values only, assembled at run time.
const os = require('os');
const { redactingWriter, scrubDir, shRedacted } = require('./gate-redact');

const fakeOpaque = (label) => `${label}${'x9'.repeat(12)}`;
const fakeJwtValue = () => ['eyJ', 'head'.repeat(3), '.', 'body'.repeat(3), '.', 'sign'.repeat(3)].join('');
const secrets = () => {
  const access = fakeJwtValue();
  const refresh = fakeOpaque('rt');
  const gatewayKey = ['gw', 'fake'.repeat(6)].join('_');
  const callLog = [
    'apiRequestContext.delete: connect ETIMEDOUT',
    'Call log:',
    '  - → DELETE https://api.example/apis/1',
    '  -   user-agent: Playwright/1.56',
    `  -   cookie: access_token=${access}; refresh_token=${refresh}`,
    `  -   x-api-key: ${gatewayKey}`,
    `  - ← 401 set-cookie: access_token=${access}; Path=/; HttpOnly`,
  ].join('\n');
  return { access, refresh, gatewayKey, callLog, all: [access, refresh, gatewayKey] };
};
const assertClean = (text, values, where) => {
  for (const v of values) assert.ok(!text.includes(v), `${where} still carries a secret`);
  assert.match(text, /<redacted>/, `${where} should say what it hid`);
};

test('redact hides every cookie of a Playwright call log, not just the first', () => {
  const s = secrets();
  const out = redact(s.callLog);
  assertClean(out, s.all, 'the call log');
  // What is not a secret stays readable.
  assert.match(out, /DELETE https:\/\/api\.example\/apis\/1/);
  assert.match(out, /user-agent: Playwright/);
});

test('redact hides tokens in storage state, JSON bodies and query strings', () => {
  const s = secrets();
  const state = JSON.stringify({ cookies: [{ name: 'access_token', value: s.access }, { name: 'refresh_token', value: s.refresh }] });
  const body = JSON.stringify({ data: { key: s.gatewayKey, refresh_token: s.refresh } });
  const query = `GET /mcp?api_key=${s.refresh}&x=1`;
  assertClean(redact(state), s.all, 'storage state');
  assertClean(redact(body), s.all, 'a JSON body');
  assertClean(redact(query), s.all, 'a query string');
});

test('a child process cannot print a secret through the gate, even split across writes', async () => {
  const s = secrets();
  // The child writes the call log in small pieces, cutting through the cookie.
  const script = `const t = process.argv[1]; for (let i = 0; i < t.length; i += 7) process.stdout.write(t.slice(i, i + 7)); process.stderr.write(t);`;
  let out = '';
  let err = '';
  const code = await shRedacted(process.execPath, ['-e', script, s.callLog], {}, { write: (x) => { out += x; } }, { write: (x) => { err += x; } });
  assert.strictEqual(code, 0);
  assertClean(out, s.all, 'stdout');
  assertClean(err, s.all, 'stderr');
  assert.match(out, /Call log:/);
});

test('redactingWriter holds a partial line until it is complete', () => {
  const s = secrets();
  let out = '';
  const w = redactingWriter((x) => { out += x; });
  w.write(`cookie: access_token=${s.access.slice(0, 10)}`);
  assert.strictEqual(out, '', 'nothing is written before the line ends');
  w.write(`${s.access.slice(10)}\n`);
  w.end();
  assertClean(out, [s.access], 'the joined line');
});

test('scrubDir rewrites the result files the gate leaves on disk', () => {
  const s = secrets();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-scrub-'));
  try {
    fs.mkdirSync(path.join(dir, 'playwright', 'j9'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'playwright-results.json'), JSON.stringify({ errors: [{ message: s.callLog }] }));
    fs.writeFileSync(path.join(dir, 'playwright', 'j9', 'error-context.md'), s.callLog);
    fs.writeFileSync(path.join(dir, 'shot.png'), s.callLog); // not text: left as it is
    const changed = scrubDir(dir);
    assert.strictEqual(changed.length, 2);
    assertClean(fs.readFileSync(path.join(dir, 'playwright-results.json'), 'utf8'), s.all, 'the JSON report');
    assertClean(fs.readFileSync(path.join(dir, 'playwright', 'j9', 'error-context.md'), 'utf8'), s.all, 'the error context');
    // Still valid JSON after redaction.
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'playwright-results.json'), 'utf8')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the report redacts its notes and every failure cell', () => {
  const s = secrets();
  const md = buildReport({
    runId: 'r', startedAt: 's', finishedAt: 'f', target: { app: 'a', api: 'b' }, health: null,
    browser: [{ suite: 's', title: 't', status: 'failed', ms: 1, screenshot: '', error: s.callLog, cleanup: '' }],
    cli: [],
    notes: [`CLI login failed: ${s.callLog}`],
  });
  assertClean(md, s.all, 'the report');
});

test('the gate runs its children piped through redaction, and the fixtures use the same redaction', () => {
  const gate = fs.readFileSync(path.join(__dirname, 'gate-staging.js'), 'utf8');
  assert.match(gate, /await shRedacted\(process\.execPath, args/, 'Playwright output is redacted');
  assert.match(gate, /await shRedacted\(process\.execPath, \[path\.join\(tests/, 'CLI smoke output is redacted');
  assert.match(gate, /scrubDir\(GATE_DIR\)/, 'result files are scrubbed');
  const fixtures = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'tests', 'staging', 'support', 'qa-api.ts'), 'utf8');
  assert.match(fixtures, /from '\.\.\/\.\.\/\.\.\/\.\.\/scripts\/gate-redact\.js'/);
});

// The gate installed only when node_modules was missing, so a lockfile that
// gained devDependencies (@modelcontextprotocol/client, openai, @a2a-js/sdk)
// left whole phases failing on a missing module.
function scratchPackage() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-install-'));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  return dir;
}
function npmInstalled(dir, at) {
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  const record = path.join(dir, 'node_modules', '.package-lock.json');
  fs.writeFileSync(record, '{}');
  fs.utimesSync(record, at, at);
}

test('installNeeded: no node_modules means install', () => {
  const dir = scratchPackage();
  try {
    assert.match(installNeeded(dir), /missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installNeeded: a lockfile newer than an install the gate did not make means install', () => {
  const dir = scratchPackage();
  try {
    const now = Date.now() / 1000;
    npmInstalled(dir, now - 3600);
    fs.utimesSync(path.join(dir, 'package-lock.json'), now, now);
    assert.match(installNeeded(dir), /newer/);
    npmInstalled(dir, now + 60);
    assert.strictEqual(installNeeded(dir), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installNeeded: after a gate install the lockfile hash decides, not its mtime', () => {
  const dir = scratchPackage();
  try {
    const now = Date.now() / 1000;
    npmInstalled(dir, now - 3600);
    writeInstallStamp(dir);
    // Touched (a branch switch) but unchanged: no reinstall.
    fs.utimesSync(path.join(dir, 'package-lock.json'), now, now);
    assert.strictEqual(installNeeded(dir), '');
    // A new dependency in the lockfile: reinstall, even if older on disk.
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/openai":{}}}\n');
    fs.utimesSync(path.join(dir, 'package-lock.json'), now - 7200, now - 7200);
    assert.match(installNeeded(dir), /changed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installNeeded: an install with no record of itself is redone', () => {
  const dir = scratchPackage();
  try {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    assert.match(installNeeded(dir), /no record/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the gate checks the install of the frontend, cli-tests and every package it builds', () => {
  const src = fs.readFileSync(path.join(__dirname, 'gate-staging.js'), 'utf8');
  assert.match(src, /function ensureInstalled\(dir\) \{\n  const why = installNeeded\(dir\);/);
  assert.match(src, /function runPlaywright\(env\) \{\n  ensureInstalled\(FRONTEND\);/);
  assert.match(src, /const pkg = pkgs\[name\];\n    ensureInstalled\(pkg\.dir\);/);
  assert.match(src, /ensureInstalled\(tests\);/);
  // Every install, and only a successful one, records its lockfile.
  assert.match(src, /npm ci failed in \$\{dir\}`\);\n  writeInstallStamp\(dir\);/);
});
