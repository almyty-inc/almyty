#!/usr/bin/env node
// The release tooling covers exactly the packages that publish.
//
// The twelve @almyty/* packages release in lockstep through Changesets
// (docs/releasing.md). Each place that lists them has to list all of them,
// or the next package added under packages/ is versioned but never
// published, or published at a version the others never reach:
//
//   .changeset/config.json  one `fixed` group with every publishable package,
//                           baseBranch development, and internal ranges left
//                           alone in the version PR (they are raised after
//                           npm has the version: scripts/release-packages.js)
//   lerna.json              the package list Changesets reads
//   publish-packages.yml    the manual fallback's package choices; it also
//                           has to publish on v* tags through
//                           scripts/release-packages.js with provenance
//   version-packages.yml    the version branch runs `npm run version-packages`
//   version-packages.yml,   open their PR through scripts/open-release-pr.js,
//   post-release.yml        never `gh pr create` or changesets/action: GitHub
//                           refuses Actions PRs here, and only that script
//                           turns the refusal into a link instead of a failure
//
// Node + a checkout, no install. Exits 0 when they agree, 1 with a report.

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const findings = [];
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const readJson = (rel) => {
  try {
    return JSON.parse(read(rel));
  } catch (err) {
    findings.push(`${rel}: ${err.message}`);
    return {};
  }
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const publishable = fs
  .readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, 'packages', e.name, 'package.json')))
  .map((e) => ({ dir: e.name, manifest: JSON.parse(read(`packages/${e.name}/package.json`)) }))
  .filter((p) => p.manifest.private !== true);
const names = publishable.map((p) => p.manifest.name);
const dirs = publishable.map((p) => p.dir);

if (publishable.length === 0) findings.push('no publishable package under packages/');

const config = readJson('.changeset/config.json');
const fixed = Array.isArray(config.fixed) ? config.fixed : [];
if (fixed.length !== 1 || !same(fixed[0], names)) {
  findings.push(`.changeset/config.json: \`fixed\` must be one group of every publishable package (${names.join(', ')}); it is ${JSON.stringify(config.fixed)}.`);
}
if ((config.linked || []).length) findings.push('.changeset/config.json: `linked` must be empty; the packages are one `fixed` group.');
if (config.baseBranch !== 'development') findings.push(`.changeset/config.json: baseBranch must be development (PRs target it), not ${config.baseBranch}.`);
if (config.access !== 'public') findings.push('.changeset/config.json: access must be public.');
if (config.bumpVersionsWithWorkspaceProtocolOnly !== true) {
  findings.push('.changeset/config.json: bumpVersionsWithWorkspaceProtocolOnly must be true. A version PR that raised internal ranges to a version npm does not have yet would leave every package-lock.json unresolvable until the release; the ranges are raised after it (scripts/release-packages.js raise-ranges).');
}

const lerna = readJson('lerna.json');
if (!same(lerna.packages || [], dirs.map((d) => `packages/${d}`))) {
  findings.push(`lerna.json: \`packages\` must list every publishable package directory (${dirs.map((d) => `packages/${d}`).join(', ')}).`);
}

const publish = read('.github/workflows/publish-packages.yml');
const options = (/^\s{6}package:\n[\s\S]*?\n\s{8}options:\n((?:\s{10}- .+\n)+)/m.exec(publish) || [])[1];
const listed = options ? options.trim().split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()) : [];
if (!same(listed, ['all', ...dirs])) {
  findings.push(`publish-packages.yml: the \`package\` input must offer all plus every publishable package directory; it offers [${listed.join(', ')}].`);
}
if (!/^on:\n[\s\S]*?^\s+push:\n\s+tags:\s*\[\s*'v\*'\s*\]/m.test(publish)) findings.push('publish-packages.yml: must publish on v* tags (`push: tags: [\'v*\']`).');
if (!/^\s+id-token:\s*write\s*$/m.test(publish)) findings.push('publish-packages.yml: needs `id-token: write` for npm trusted publishing.');
if (!/node scripts\/release-packages\.js publish/.test(publish) || !/--provenance/.test(publish)) {
  findings.push('publish-packages.yml: must publish with `node scripts/release-packages.js publish --provenance`.');
}

const rootPkg = readJson('package.json');
if (!(rootPkg.devDependencies || {})['@changesets/cli']) findings.push('package.json: @changesets/cli must be a devDependency.');
if ((rootPkg.scripts || {})['version-packages'] !== 'node scripts/release-packages.js version') {
  findings.push('package.json: scripts.version-packages must be `node scripts/release-packages.js version`.');
}
const versionWf = read('.github/workflows/version-packages.yml');
if (!/^\s+npm run version-packages\s*$/m.test(versionWf)) {
  findings.push('version-packages.yml: the version step must run `npm run version-packages`.');
}
if (!/changeset-release\//.test(versionWf)) findings.push('version-packages.yml: must push the changeset-release/<base> branch.');

// GitHub Actions may not open pull requests here. Each workflow that pushes
// a release branch opens its PR through scripts/open-release-pr.js, which
// turns that refusal into a job summary with the link instead of a failure.
for (const wf of ['version-packages.yml', 'post-release.yml']) {
  const text = wf === 'version-packages.yml' ? versionWf : read(`.github/workflows/${wf}`);
  if (!/node scripts\/open-release-pr\.js /.test(text)) findings.push(`${wf}: must open its PR with \`node scripts/open-release-pr.js\`.`);
  if (/gh pr create|changesets\/action@/.test(text)) {
    findings.push(`${wf}: must not open the PR with \`gh pr create\` or changesets/action; GitHub refuses Actions here and the job would fail (use scripts/open-release-pr.js).`);
  }
}

if (findings.length) {
  console.error('check-release-config: FAIL\n');
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-release-config: OK — ${names.length} packages in one fixed group, listed everywhere the release reads them.`);
