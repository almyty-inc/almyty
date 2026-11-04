'use strict';

// node --test scripts/open-release-pr.test.js
//
// Runs open-release-pr.js against a fake `gh` on PATH. The fake answers from
// environment variables and records each call, so every case decides what
// GitHub says and checks what the script did with it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'open-release-pr.js');
const REFUSAL = 'pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)';

// FAKE_LIST: stdout of `gh pr list`. FAKE_CREATE: ok | refused | other.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_CALLS"
case "$1 $2" in
  "pr list") printf '%s' "$FAKE_LIST"; exit 0 ;;
  "pr edit") exit 0 ;;
  "pr create")
    case "$FAKE_CREATE" in
      ok) echo "https://github.com/acme/repo/pull/7"; exit 0 ;;
      refused) echo "${REFUSAL}" >&2; exit 1 ;;
      *) echo "HTTP 422: Validation Failed" >&2; exit 1 ;;
    esac ;;
esac
exit 2
`;

function run(t, { list = '', create = 'ok' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-release-pr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'gh'), FAKE_GH, { mode: 0o755 });
  const body = path.join(dir, 'body.md');
  fs.writeFileSync(body, 'Moves all twelve packages to 1.5.9.\n');
  const files = { calls: path.join(dir, 'calls'), summary: path.join(dir, 'summary.md') };
  const r = spawnSync(process.execPath, [SCRIPT, '--branch', 'changeset-release/development', '--base', 'development', '--title', 'Version packages', '--body-file', body], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      FAKE_CALLS: files.calls,
      FAKE_LIST: list,
      FAKE_CREATE: create,
      GITHUB_STEP_SUMMARY: files.summary,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'acme/repo',
    },
  });
  const readOr = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { code: r.status, out: r.stdout, err: r.stderr, calls: readOr(files.calls), summary: readOr(files.summary) };
}

test('opens the PR when GitHub allows it', (t) => {
  const r = run(t);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.calls, /^pr create --base development --head changeset-release\/development --title Version packages/m);
  assert.match(r.summary, /Opened https:\/\/github\.com\/acme\/repo\/pull\/7/);
});

test('a refusal to let Actions open PRs passes, with the compare link in the summary and a notice', (t) => {
  const r = run(t, { create: 'refused' });
  assert.strictEqual(r.code, 0, r.err);
  const url = 'https://github.com/acme/repo/compare/development...changeset-release/development?expand=1&title=Version%20packages';
  assert.ok(r.summary.includes(`](${url})`), r.summary);
  assert.match(r.summary, /Pushed `changeset-release\/development`/);
  assert.match(r.summary, /Moves all twelve packages to 1\.5\.9\./);
  assert.match(r.out, /^::notice title=Open the PR by hand::/m);
  assert.ok(r.out.includes(url));
});

test('any other error opening the PR fails the job', (t) => {
  const r = run(t, { create: 'other' });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /gh pr create failed: HTTP 422/);
  assert.doesNotMatch(r.out, /::notice/);
  assert.strictEqual(r.summary, '');
});

test('an open PR for the branch is updated, not opened again', (t) => {
  const r = run(t, { list: 'https://github.com/acme/repo/pull/5', create: 'other' });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.calls, /^pr edit https:\/\/github\.com\/acme\/repo\/pull\/5 --title Version packages --body-file /m);
  assert.doesNotMatch(r.calls, /pr create/);
  assert.match(r.summary, /Updated the open PR: https:\/\/github\.com\/acme\/repo\/pull\/5/);
});

test('a missing argument fails', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--branch', 'x'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /missing --base/);
});
