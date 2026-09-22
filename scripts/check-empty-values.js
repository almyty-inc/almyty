#!/usr/bin/env node
// Empty-slot gate for build and deploy files.
//
// `frontend/Dockerfile` shipped `FROM --platform= node:26-alpine AS base`
// for months: the `$BUILDPLATFORM` had been eaten out of a PR whose entire
// purpose was building on the host's native arch. BuildKit reads the empty
// value as "unset", inherits the target platform, and says nothing — so the
// vite build ran under QEMU on every arm64 leg with a comment right above
// warning about exactly that. Nothing failed. Nothing warned.
//
// The shape is a syntactically valid file with a semantically empty slot.
// This script fails CI on the shapes that are never deliberate:
//
//   --flag=            a long flag whose value was eaten (bare `=` then
//                      whitespace or end of line). An intentionally empty
//                      value is written `--flag=""` and is NOT flagged,
//                      and `ARG X=` / `ENV X=` / `KEY=` are untouched —
//                      an empty default there is a normal idiom.
//   ${}  $()           an interpolation or substitution with nothing in it.
//   COPY --from=       a copy from a stage that was never named.
//   FROM x AS          a stage declared with no alias.
//   EXPOSE / USER / WORKDIR with no operand.
//
// No dependencies — just Node's fs. Exits 0 when clean, 1 with a report.

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

// Files whose empty slots are build/deploy defects. Everything else (source,
// docs, fixtures) is out of scope on purpose: an empty string is a legitimate
// value in plenty of places, and a gate with false positives gets deleted.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);
const INCLUDE = [
  /(^|\/)Dockerfile[^/]*$/,
  /^docker-compose[^/]*\.ya?ml$/,
  /^k8s\//,
  /^scripts\/.*\.(sh|js)$/,
  /^\.github\/workflows\/.*\.ya?ml$/,
  /^frontend\/(docker-entrypoint\.sh|nginx\.conf)$/,
  /(^|\/)package\.json$/,
];

const RULES = [
  {
    id: 'empty-flag-value',
    // A long flag, `=`, then nothing. `--flag=""` and `--flag=''` are an
    // explicit empty and pass; only the eaten value is caught.
    re: /(^|\s)(--[A-Za-z][A-Za-z0-9-]*)=(?=\s|$)/,
    say: (m) => `\`${m[2]}=\` has no value`,
  },
  {
    id: 'empty-interpolation',
    re: /(\$\{\s*\})|(\$\(\s*\))/,
    say: () => 'an interpolation with nothing in it',
  },
  {
    id: 'docker-empty-slot',
    re: /^\s*(COPY\s+--from=(?=\s)|FROM\s+\S+\s+AS\s*$|EXPOSE\s*$|USER\s*$|WORKDIR\s*$)/i,
    say: () => 'a Dockerfile instruction with no operand',
  },
];

function inScope(rel) {
  return INCLUDE.some((re) => re.test(rel));
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const findings = [];
let scanned = 0;

for (const full of walk(repoRoot, [])) {
  const rel = path.relative(repoRoot, full).split(path.sep).join('/');
  if (!inScope(rel)) continue;

  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;

  text.split('\n').forEach((line, i) => {
    // A comment cannot break a build; skip the obvious comment forms so a
    // note describing the shape does not fail the gate that describes it.
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m) findings.push({ rel, line: i + 1, rule: rule.id, why: rule.say(m), text: trimmed });
    }
  });
}

if (findings.length === 0) {
  console.log(`check-empty-values: ${scanned} build/deploy files, no empty slots.`);
  process.exit(0);
}

console.error('check-empty-values: a value was eaten out of a build/deploy file.\n');
for (const f of findings) {
  console.error(`  ${f.rel}:${f.line}  ${f.why}  [${f.rule}]`);
  console.error(`    ${f.text}`);
}
console.error(
  '\nThese parse fine and do nothing. If the empty value is genuinely what you\n' +
    'want, write it explicitly (--flag="") so the next reader can tell.',
);
process.exit(1);
