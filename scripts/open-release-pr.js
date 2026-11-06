#!/usr/bin/env node
// Open or update the PR for a release branch the workflow already pushed.
//
//   node scripts/open-release-pr.js --branch <head> --base <base> --title <t> --body-file <f>
//
// Used by version-packages.yml and post-release.yml. This repository does not
// let GitHub Actions create pull requests, so `gh pr create` is refused there.
// That refusal is expected and does not fail the job: the job summary links
// the pushed branch so whoever runs the release opens the PR by hand, and a
// PR opened by a person runs CI like any other. Any other error fails.
//
// An open PR for the branch (opened by a person earlier) is updated in place;
// editing a PR is allowed where creating one is not.
//
// Needs gh on PATH with GH_TOKEN. Writes to $GITHUB_STEP_SUMMARY when set.

'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

const REFUSED = /not permitted to create or approve pull requests/i;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['branch', 'base', 'title', 'body-file']) {
    if (!args[k]) throw new Error(`missing --${k}`);
  }
  return args;
}

function compareUrl({ branch, base, title }, env = process.env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const repo = env.GITHUB_REPOSITORY || '<owner>/<repo>';
  return `${server}/${repo}/compare/${base}...${branch}?expand=1&title=${encodeURIComponent(title)}`;
}

function main({ argv = process.argv.slice(2), env = process.env, log = console.log, error = console.error } = {}) {
  const args = parseArgs(argv);
  const gh = (...a) => spawnSync('gh', a, { encoding: 'utf8', env });
  const summary = (text) => {
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  const fail = (what, r) => {
    error(`${what} failed: ${(r.stderr || r.stdout || (r.error && r.error.message) || '').trim()}`);
    return 1;
  };

  const list = gh('pr', 'list', '--head', args.branch, '--base', args.base, '--state', 'open', '--json', 'url', '-q', '.[0].url');
  if (list.status !== 0) return fail('gh pr list', list);
  const existing = list.stdout.trim();

  if (existing) {
    const edit = gh('pr', 'edit', existing, '--title', args.title, '--body-file', args['body-file']);
    if (edit.status !== 0) return fail('gh pr edit', edit);
    log(`Updated ${existing}`);
    summary(`### ${args.title}\n\nUpdated the open PR: ${existing}`);
    return 0;
  }

  const create = gh('pr', 'create', '--base', args.base, '--head', args.branch, '--title', args.title, '--body-file', args['body-file']);
  if (create.status === 0) {
    const url = create.stdout.trim();
    log(`Opened ${url}`);
    summary(`### ${args.title}\n\nOpened ${url}`);
    return 0;
  }
  if (!REFUSED.test(`${create.stderr}\n${create.stdout}`)) return fail('gh pr create', create);

  const url = compareUrl(args, env);
  const body = fs.readFileSync(args['body-file'], 'utf8').trim();
  log(`::notice title=Open the PR by hand::Pushed ${args.branch}. GitHub Actions may not open pull requests in this repository; open it at ${url}`);
  summary([
    `### ${args.title}: open the PR`,
    '',
    `Pushed \`${args.branch}\`. This repository does not let GitHub Actions open pull requests, so open it yourself:`,
    '',
    `**[Open the PR from \`${args.branch}\` into \`${args.base}\`](${url})**`,
    '',
    'A PR you open runs CI as usual. Suggested description:',
    '',
    '<details><summary>PR body</summary>',
    '',
    body,
    '',
    '</details>',
  ].join('\n'));
  return 0;
}

module.exports = { main, compareUrl, REFUSED };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`open-release-pr: ${err.message}`);
    process.exit(1);
  }
}
