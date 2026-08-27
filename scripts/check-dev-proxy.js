#!/usr/bin/env node
// Every API prefix must have a dev-proxy rule.
//
// `npm run dev` serves the SPA on one port and proxies the API to
// another. A backend @Controller('runners') with no '/runners' rule in
// vite.config.ts does not fail loudly: vite answers with index.html, so
// the page gets HTML where it expected JSON and dies parsing it. Nothing
// in either test suite notices, because both sides mock the other.
//
// This has bitten twice. The second time, eighteen prefixes were missing
// at once and most of the dashboard was dead in local dev while every
// test was green.
//
// No dependencies — just Node's fs. Exits 0 when every prefix is
// covered, 1 with the list of missing rules otherwise.

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const backendSrc = path.join(repoRoot, 'backend', 'src');
const viteConfig = path.join(repoRoot, 'frontend', 'vite.config.ts');

/**
 * Prefixes the dev proxy deliberately does not carry.
 *
 * Empty on purpose: proxying a prefix the browser never calls costs
 * nothing, and the alternative is arguing about which ones qualify. Add
 * an entry only when a rule would actively break something, and say why.
 */
const NOT_PROXIED = new Set([]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The first path segment of every @Controller() in the backend. */
function controllerPrefixes() {
  const prefixes = new Set();

  for (const file of walk(backendSrc)) {
    const source = fs.readFileSync(file, 'utf8');
    // Both @Controller('x') and @Controller({ path: 'x' }).
    const pattern = /@Controller\(\s*(?:\{[^}]*?path:\s*)?['"]([^'"]*)['"]/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      // A parameterised first segment (':id') is not a fixed prefix and
      // cannot have a rule of its own.
      const first = match[1].split('/')[0];
      if (first && !first.startsWith(':')) prefixes.add(first);
    }
  }

  return prefixes;
}

/** The keys of the `proxy` map in the dev server config. */
function proxiedPrefixes() {
  const source = fs.readFileSync(viteConfig, 'utf8');
  const prefixes = new Set();

  const pattern = /^\s*'\/([^'/]+)(?:\/[^']*)?'\s*:\s*\{/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) prefixes.add(match[1]);

  return prefixes;
}

const declared = controllerPrefixes();
const proxied = proxiedPrefixes();

if (declared.size === 0) {
  console.error('check-dev-proxy: found no controllers, which means this check is broken');
  process.exit(1);
}

const missing = [...declared].filter((p) => !proxied.has(p) && !NOT_PROXIED.has(p)).sort();

if (missing.length > 0) {
  console.error('check-dev-proxy: API prefixes with no rule in frontend/vite.config.ts:\n');
  for (const prefix of missing) console.error(`  /${prefix}`);
  console.error(
    '\nWithout a rule these answer with index.html under `npm run dev`, so the page' +
      '\nfails parsing HTML as JSON. Add each one to the proxy map:\n' +
      "\n      '/<prefix>': {" +
      '\n        target: apiTarget,' +
      '\n        changeOrigin: true,' +
      '\n        bypass: bypassHtmlGetRequests,' +
      '\n      },\n' +
      '\nUse bypassHtmlGetRequests whenever the SPA has a route of the same name, so' +
      '\nan HTML GET still reaches the router. If a prefix is genuinely never called' +
      '\nfrom the browser, add it to NOT_PROXIED in this script with a reason.',
  );
  process.exit(1);
}

console.log(`check-dev-proxy: all ${declared.size} API prefixes are proxied.`);
