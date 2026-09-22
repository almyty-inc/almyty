#!/usr/bin/env node
// Node major-version lockstep across CI, the images, and engines.node.
//
// Why this exists: Dependabot's `docker` ecosystem bumps the `FROM node:`
// line in a Dockerfile (that is literally how 24 -> 26 landed), but NOTHING
// bumps `node-version:` in the workflows or `engines.node` in a
// package.json. The three drifted apart and stayed apart, and two real
// breakages hid in the gap — Node 26 ships a `localStorage` global that
// shadows jsdom's, and Node 26 brought network under `--permission`, so
// every sandboxed JavaScript tool's fetch would have died in production
// with a bare "fetch failed". Neither was visible because CI was green:
// CI was running a different major than the image.
//
// So: assert the three agree, statically, on every PR. No install, no
// network — just a checkout.
//
// DELIBERATELY EXEMPT: packages/* keep a permissive floor (>=20, or no
// engines at all). They publish to npm and raising the floor would refuse
// installs for users on Node 20 or 22. Do not "fix" those.

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const findings = [];
const seen = new Map(); // major -> [where, ...]

function record(major, where) {
  if (!seen.has(major)) seen.set(major, []);
  seen.get(major).push(where);
}

function rel(p) {
  return path.relative(root, p);
}

// ── 1. Dockerfiles: every `FROM node:<major>` ──────────────────────
function walkDockerfiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDockerfiles(full, out);
    else if (entry.name === 'Dockerfile' || entry.name.startsWith('Dockerfile.')) out.push(full);
  }
  return out;
}

for (const file of walkDockerfiles(root, [])) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = /^FROM\s+(?:--platform=\S*\s+)?node:(\d+)[-.]/.exec(line.trim());
    if (m) record(Number(m[1]), `${rel(file)}:${i + 1} (FROM node:${m[1]})`);
  });
}

// ── 2. Workflows: every `node-version:` ────────────────────────────
const wfDir = path.join(root, '.github', 'workflows');
if (fs.existsSync(wfDir)) {
  for (const name of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const file = path.join(wfDir, name);
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const m = /node-version:\s*['"]?(\d+)/.exec(line);
        if (m) record(Number(m[1]), `${rel(file)}:${i + 1} (node-version: ${m[1]})`);
      });
  }
}

// ── 3. engines.node on the deployed workspaces ─────────────────────
// packages/* are exempt on purpose — see the header.
for (const dir of ['.', 'backend', 'frontend', 'docs-site']) {
  const file = path.join(root, dir, 'package.json');
  if (!fs.existsSync(file)) continue;
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const range = pkg.engines && pkg.engines.node;
  if (!range) {
    findings.push(`${rel(file)}: no engines.node — every deployed workspace must pin one.`);
    continue;
  }
  const m = /(\d+)/.exec(range);
  if (!m) {
    findings.push(`${rel(file)}: engines.node "${range}" has no parseable major.`);
    continue;
  }
  record(Number(m[1]), `${rel(file)} (engines.node "${range}")`);
}

// ── Verdict ────────────────────────────────────────────────────────
if (seen.size > 1) {
  const majors = [...seen.keys()].sort((a, b) => a - b);
  findings.push(
    `Node major is not in lockstep — found ${majors.join(' and ')}:\n` +
      majors
        .map((maj) => `  Node ${maj}:\n` + seen.get(maj).map((w) => `    ${w}`).join('\n'))
        .join('\n'),
  );
}

if (findings.length) {
  console.error('check-node-version: FAIL\n');
  for (const f of findings) console.error(f + '\n');
  console.error(
    'Bump every site to the same major. CI running a different Node than the\n' +
      'image is how the jsdom localStorage clash and the --permission network\n' +
      'gate both stayed invisible.',
  );
  process.exit(1);
}

const [major] = [...seen.keys()];
console.log(
  `check-node-version: OK — Node ${major} across ${seen.get(major).length} declaration sites ` +
    '(packages/* exempt by design).',
);
