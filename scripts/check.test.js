'use strict';

// node --test scripts/check.test.js
//
// `npm run check` is the one list of repo invariants, and CI's
// repo-invariants job runs it. These tests keep that true: every check and
// every test under scripts/ is a step, every step names a file that
// exists, CI calls the list rather than restating it, and a failing step
// fails the run without hiding the steps after it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STEPS, runSteps } = require('./check.js');

const repo = path.join(__dirname, '..');
const commands = STEPS.map((s) => s.cmd);

test('every scripts/check-*.js runs as a step', () => {
  for (const file of fs.readdirSync(__dirname).filter((f) => /^check-.+\.js$/.test(f) && !f.endsWith('.test.js'))) {
    assert.ok(commands.includes(`node scripts/${file}`), `scripts/${file} is not a step in scripts/check.js`);
  }
});

test('every check has a test, and every test under scripts/ runs as a step', () => {
  const files = fs.readdirSync(__dirname);
  for (const file of files.filter((f) => /^check-.+\.js$/.test(f) && !f.endsWith('.test.js'))) {
    assert.ok(files.includes(file.replace(/\.js$/, '.test.js')), `scripts/${file} has no test next to it`);
  }
  for (const file of files.filter((f) => f.endsWith('.test.js'))) {
    assert.ok(commands.includes(`node --test scripts/${file}`), `scripts/${file} is not a step in scripts/check.js`);
  }
});

test('each check runs after its own test', () => {
  for (const [i, cmd] of commands.entries()) {
    const m = /^node (scripts\/check-.+)\.js$/.exec(cmd);
    if (!m) continue;
    const testAt = commands.indexOf(`node --test ${m[1]}.test.js`);
    assert.ok(testAt !== -1 && testAt < i, `${cmd} does not run after its test`);
  }
});

test('every step names a file that exists', () => {
  for (const cmd of commands) {
    const file = cmd.split(' ').find((part) => /\.(m?js|sh)$/.test(part));
    assert.ok(file, `${cmd} names no script`);
    assert.ok(fs.existsSync(path.join(repo, file)), `${cmd}: ${file} does not exist`);
  }
});

test('npm run check is this file, and the repo-invariants CI job runs it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts.check, 'node scripts/check.js');

  const ci = fs.readFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = /\n {2}repo-invariants:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|$)/.exec(ci);
  assert.ok(job, 'ci.yml has no repo-invariants job');
  assert.match(job[1], /run: npm run check\n/);
  for (const cmd of commands) {
    assert.ok(!job[1].includes(cmd), `ci.yml restates "${cmd}"; it belongs in scripts/check.js only`);
  }
});

test('a failing step fails the run and the steps after it still run', () => {
  const lines = [];
  const failed = runSteps(
    [
      { name: 'passes', cmd: 'node -e "process.exit(0)"' },
      { name: 'fails', cmd: 'node -e "process.exit(3)"' },
      { name: 'passes after', cmd: 'node -e "process.exit(0)"' },
    ],
    { ci: false, log: (l) => lines.push(l) },
  );
  assert.deepStrictEqual(failed.map((s) => s.name), ['fails']);
  const out = lines.join('\n');
  assert.match(out, /FAIL fails \(exit 3/);
  assert.match(out, /ok {3}passes after/);
  assert.match(out, /check: 1 of 3 steps failed/);
});

test('under GitHub Actions each step is a log group and a failure an annotation', () => {
  const lines = [];
  runSteps([{ name: 'fails', cmd: 'node -e "process.exit(1)"' }], { ci: true, log: (l) => lines.push(l) });
  assert.strictEqual(lines[0], '::group::[1/1] fails');
  assert.ok(lines.includes('::endgroup::'));
  assert.ok(lines.some((l) => l.startsWith('::error title=fails::')));
});
