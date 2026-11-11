#!/usr/bin/env node
// Every repo invariant, in the order CI runs them: `npm run check`.
//
// The repo-invariants job in .github/workflows/ci.yml runs exactly this, so
// a green `npm run check` on your machine is the same verdict CI gives. Each
// check is Node + a checkout, no install (the demo seed's step installs its
// own two dependencies). A check's tests run right before
// it, so a check that was weakened fails its own tests first.
//
// Every step runs even after one fails, so one push shows every broken
// invariant; the exit code is 1 if any failed. Under GitHub Actions each
// step is a collapsible group in the log and a failure is an annotation.
//
//   npm run check              all of them
//   npm run check -- --list    print the steps without running them
//
// Adding a check: put scripts/check-<name>.js next to a
// scripts/check-<name>.test.js and list both below. check.test.js fails
// while a check-*.js or a *.test.js under scripts/ is missing from STEPS.

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');

const STEPS = [
  { name: 'Test the @almyty/* version lockstep check', cmd: 'node --test scripts/check-npm-lockstep.test.js' },
  { name: 'Check @almyty/* version lockstep', cmd: 'node scripts/check-npm-lockstep.js' },
  { name: 'Test the CLI version check', cmd: 'node --test scripts/check-cli-versions.test.js' },
  { name: 'Check every CLI reports its own version', cmd: 'node scripts/check-cli-versions.js' },
  { name: 'Test the package-lock check', cmd: 'node --test scripts/check-package-locks.test.js' },
  { name: 'Check every package-lock still describes its package.json', cmd: 'node scripts/check-package-locks.js' },
  { name: 'Test the dev proxy check', cmd: 'node --test scripts/check-dev-proxy.test.js' },
  { name: 'Check dev proxy covers every API prefix', cmd: 'node scripts/check-dev-proxy.js' },
  { name: 'Test the Node major check', cmd: 'node --test scripts/check-node-version.test.js' },
  { name: 'Check Node major is in lockstep', cmd: 'node scripts/check-node-version.js' },
  { name: 'Test the empty-value check', cmd: 'node --test scripts/check-empty-values.test.js' },
  { name: 'Check no build/deploy value was eaten', cmd: 'node scripts/check-empty-values.js' },
  { name: 'Test the runner-env image check', cmd: 'node --test scripts/check-runner-env-images.test.js' },
  { name: 'Check the runner-env images agree with their settings list', cmd: 'node scripts/check-runner-env-images.js' },
  { name: 'Test the release config check', cmd: 'node --test scripts/check-release-config.test.js' },
  { name: 'Check the release tooling covers every publishable package', cmd: 'node scripts/check-release-config.js' },
  { name: 'Test the release PR opener', cmd: 'node --test scripts/open-release-pr.test.js' },
  { name: 'Test the release tooling', cmd: 'node --test scripts/release-packages.test.js' },
  { name: 'Test the npm audit retry classification', cmd: 'node --test scripts/npm-audit-retry.test.js' },
  { name: 'Test the CLI help capture', cmd: 'node --test scripts/capture-cli-help.test.js' },
  { name: 'Test the wait for npm to serve a release', cmd: 'node --test scripts/wait-for-npm.test.js' },
  { name: 'Test this runner', cmd: 'node --test scripts/check.test.js' },
  { name: 'Test screenshot evidence validation', cmd: 'node --test docs-site/scripts/check-screenshots.test.mjs' },
  { name: 'Check screenshot inventory and source freshness', cmd: 'node docs-site/scripts/check-screenshots.mjs' },
  { name: 'Test the docs llms.txt generator', cmd: 'node --test docs-site/scripts/check-llms.test.mjs' },
  { name: 'Check docs llms.txt and llms-full.txt list every docs page', cmd: 'node docs-site/scripts/check-llms.mjs' },
  // The one step that installs: the demo seed's walk engine needs zod. Its
  // tests prove every local-demo screenshot above is taken by a walk step.
  { name: 'Test the demo-seed walks, their schema and manifest coverage', cmd: 'sh scripts/demo-seed/check.sh' },
];

// Runs each step through the shell from the repo root, the way a workflow
// `run:` line does. Returns the steps that failed.
function runSteps(steps, { ci = process.env.GITHUB_ACTIONS === 'true', log = console.log } = {}) {
  const failed = [];
  for (const [i, step] of steps.entries()) {
    const label = `[${i + 1}/${steps.length}] ${step.name}`;
    if (ci) log(`::group::${label}`);
    else log(`\n== ${label}`);
    log(`$ ${step.cmd}`);
    const started = Date.now();
    const r = spawnSync(step.cmd, { cwd: repoRoot, stdio: 'inherit', shell: true });
    const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    if (ci) log('::endgroup::');
    if (r.status === 0) {
      log(`ok   ${step.name} (${took})`);
      continue;
    }
    failed.push(step);
    const why = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    log(ci ? `::error title=${step.name}::${step.cmd} failed (${why})` : `FAIL ${step.name} (${why}, ${took})`);
  }
  log('');
  if (failed.length) {
    log(`check: ${failed.length} of ${steps.length} steps failed:`);
    for (const step of failed) log(`  ${step.name}\n    $ ${step.cmd}`);
  } else {
    log(`check: all ${steps.length} steps passed.`);
  }
  return failed;
}

module.exports = { STEPS, runSteps };

if (require.main === module) {
  if (process.argv.includes('--list')) {
    for (const step of STEPS) console.log(`${step.name}\n  $ ${step.cmd}`);
    process.exit(0);
  }
  process.exit(runSteps(STEPS).length ? 1 : 0);
}
