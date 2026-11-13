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
const { playwrightRows, vitestRows, buildReport, firstLine } = require('./gate-staging');

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
