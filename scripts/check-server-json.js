#!/usr/bin/env node
// packages/mcp-server/server.json, the MCP Registry entry for @almyty/mcp-server.
//
//   node scripts/check-server-json.js            offline: agrees with the package
//   node scripts/check-server-json.js --schema   also validates against the
//                                                published schema ($schema URL)
//
// Offline, it checks what the registry checks at publish time plus what drifts
// silently: the name matches package.json `mcpName` (the registry's npm
// ownership proof), both versions match package.json, the description fits the
// registry's 100 characters, and the environment variables listed are exactly
// the ALMYTY_* variables the package reads.
//
// --schema needs the network and ajv (`npm --prefix backend ci` installs it).

'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const repoRoot = path.join(__dirname, '..');
const PKG_DIR = path.join('packages', 'mcp-server');

// Where the package reads its environment: its own source and the shared
// credential resolver it re-exports.
const SOURCE_DIRS = [path.join('packages', 'mcp-server', 'src')];
const SOURCE_FILES = [path.join('packages', 'client', 'src', 'credentials.ts')];

function sourceFiles(root) {
  const out = SOURCE_FILES.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
  for (const dir of SOURCE_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path.join(abs, name));
    }
  }
  return out;
}

/** The ALMYTY_* variables read through process.env in `texts`. */
function envRead(texts) {
  const names = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(/process\.env\.(ALMYTY_[A-Z0-9_]+)/g)) names.add(m[1]);
  }
  return names;
}

/** Every way `server` disagrees with `pkg` and with the variables the code reads. */
function findings(server, pkg, readVars) {
  const out = [];
  if (!pkg.mcpName) out.push('package.json has no "mcpName"; the registry needs it to prove npm ownership');
  else if (server.name !== pkg.mcpName) out.push(`server.json name "${server.name}" does not match package.json mcpName "${pkg.mcpName}"`);
  if (server.version !== pkg.version) out.push(`server.json version ${server.version} does not match package.json ${pkg.version}`);
  const desc = server.description || '';
  if (desc.length < 1 || desc.length > 100) out.push(`description is ${desc.length} characters; the registry allows 1 to 100`);

  const npm = (server.packages || []).filter((p) => p.registryType === 'npm' && p.identifier === pkg.name);
  if (npm.length !== 1) {
    out.push(`server.json lists ${npm.length} npm packages named ${pkg.name}; expected exactly one`);
    return out;
  }
  const entry = npm[0];
  if (entry.version !== pkg.version) out.push(`npm package version ${entry.version} does not match package.json ${pkg.version}`);
  if (!entry.transport || entry.transport.type !== 'stdio') out.push('the npm package transport must be stdio');

  const listed = new Set((entry.environmentVariables || []).map((v) => v.name));
  for (const name of readVars) if (!listed.has(name)) out.push(`${name} is read by the package but not listed in server.json`);
  for (const name of listed) if (!readVars.has(name)) out.push(`${name} is listed in server.json but the package never reads it`);
  return out;
}

function check(root = repoRoot) {
  const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const server = readJson(path.join(PKG_DIR, 'server.json'));
  const pkg = readJson(path.join(PKG_DIR, 'package.json'));
  const readVars = envRead(sourceFiles(root).map((f) => fs.readFileSync(f, 'utf8')));
  return { server, problems: findings(server, pkg, readVars) };
}

/** Validate against the JSON schema `server.$schema` names, fetched from the web. */
async function schemaProblems(server, root = repoRoot) {
  let Ajv;
  try {
    Ajv = createRequire(path.join(root, 'backend', 'package.json'))('ajv');
  } catch {
    throw new Error('ajv not found; run `npm --prefix backend ci` first');
  }
  if (!server.$schema) return ['server.json has no $schema'];
  const res = await fetch(server.$schema);
  if (!res.ok) throw new Error(`fetching ${server.$schema}: HTTP ${res.status}`);
  const schema = await res.json();
  const ajv = new (Ajv.default || Ajv)({ strict: false, allErrors: true });
  ajv.addFormat('uri', (s) => {
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  });
  const validate = ajv.compile(schema);
  if (validate(server)) return [];
  return validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}${e.params && e.params.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}`);
}

module.exports = { envRead, findings, check, schemaProblems };

if (require.main === module) {
  (async () => {
    const { server, problems } = check();
    if (process.argv.includes('--schema')) {
      try {
        problems.push(...(await schemaProblems(server)));
      } catch (err) {
        problems.push(err.message);
      }
    }
    if (problems.length) {
      for (const p of problems) console.error(`check-server-json: ${p}`);
      process.exit(1);
    }
    console.log(`check-server-json: ${server.name} ${server.version} ok${process.argv.includes('--schema') ? ` (valid against ${server.$schema})` : ''}`);
  })();
}
