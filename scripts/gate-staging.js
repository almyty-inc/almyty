#!/usr/bin/env node
'use strict';

/**
 * The staging gate: `npm run gate:staging`. Run it from this machine
 * before every release.
 *
 *   1. GET /health/ready on the staging API.
 *   2. The staging Playwright suite (frontend/tests/staging) as the QA
 *      user, against the deployed app, with no stubs.
 *   3. The CLI smoke tests (packages/cli-tests), signed in as the QA user
 *      through the real `almyty login` browser flow in a throwaway HOME.
 *      The API key that login mints is revoked afterwards.
 *
 * It writes gate-report.md at the repo root: pass/fail per feature, a
 * screenshot per browser test, and for a failing test the product
 * finding recorded in scripts/gate-findings.json, if there is one.
 *
 * Nothing here reads or passes a vendor key. The QA user's organization
 * has its models connected in the product; the QA address and password
 * come from .env.staging-qa.local and are only typed into the login page.
 *
 * Options (env):
 *   GATE_ONLY=playwright,cli,health   run a subset
 *   GATE_GREP=<pattern>               passed to Playwright --grep
 *   GATE_WORKERS=<n>                  Playwright workers (default 2)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const PACKAGES = path.join(ROOT, 'packages');
const GATE_DIR = path.join(ROOT, 'gate-results');
const REPORT = path.join(ROOT, 'gate-report.md');
const FINDINGS = path.join(__dirname, 'gate-findings.json');
const CLI_PACKAGES = ['auth-cli', 'agents-cli', 'chat-cli', 'skills-cli', 'mcp-server', 'models-cli', 'credentials-cli', 'almyty-cli'];

// ── pure parts (tested in gate-staging.test.js) ─────────────────────

/** Rows `{ suite, title, status, ms, screenshot, error }` from Playwright's JSON report. */
function playwrightRows(report) {
  const rows = [];
  const walk = (suite, parents) => {
    const here = suite.title && !/\.(spec|test)\.ts$/.test(suite.title) ? [...parents, suite.title] : parents;
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const results = t.results || []
        const last = results[results.length - 1] || {};
        const annotations = [...(t.annotations || []), ...(last.annotations || [])];
        const shot = annotations.find((a) => a.type === 'screenshot')?.description
          || (last.attachments || []).find((a) => a.name === 'screenshot' && a.path)?.path
          || '';
        const status = t.status === 'skipped' ? 'skipped' : last.status === 'passed' ? 'passed' : last.status || t.status || 'unknown';
        rows.push({
          suite: here.join(' › '),
          title: spec.title,
          status: status === 'timedOut' ? 'failed' : status,
          ms: last.duration || 0,
          screenshot: shot,
          error: firstLine(last.error?.message || (last.errors || [])[0]?.message || ''),
          cleanup: [...new Set(annotations.filter((a) => a.type === 'cleanup').map((a) => a.description))].join('; '),
        });
      }
    }
    for (const child of suite.suites || []) walk(child, here);
  };
  for (const suite of report.suites || []) walk(suite, []);
  return rows;
}

/** Rows from vitest's JSON report. */
function vitestRows(report) {
  const rows = [];
  for (const file of report.testResults || []) {
    for (const a of file.assertionResults || []) {
      rows.push({
        suite: (a.ancestorTitles || []).join(' › '),
        title: a.title,
        status: a.status === 'pending' || a.status === 'skipped' || a.status === 'todo' ? 'skipped' : a.status,
        ms: a.duration || 0,
        screenshot: '',
        error: firstLine((a.failureMessages || [])[0] || ''),
      });
    }
  }
  return rows;
}

function firstLine(s) {
  // Strip ANSI colour codes, keep the first meaningful line.
  const clean = String(s).replace(/\u001b\[[0-9;]*m/g, '');
  return (clean.split('\n').find((l) => l.trim()) || '').trim().slice(0, 240);
}

/** A session token or API key must never reach the report. */
function redact(s) {
  return String(s)
    .replace(/(access_token=|Bearer\s+|cookie:\s*)[^\s;,"]+/gi, '$1<redacted>')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<redacted>')
    .replace(/almyty_[0-9a-f]{16,}/g, '<redacted>');
}

function cell(s) {
  return redact(String(s ?? '')).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 600);
}

/**
 * The report. `findings` maps a test title to the product fault behind
 * its failure ({ finding, rootCause }); a passing test's entry is shown as
 * resolved, never hidden.
 */
function buildReport({ runId, startedAt, finishedAt, target, health, browser, cli, findings = {}, notes = [] }) {
  const all = [...browser.map((r) => ({ ...r, kind: 'browser' })), ...cli.map((r) => ({ ...r, kind: 'cli' }))];
  const count = (s) => all.filter((r) => r.status === s).length + (health && health.status === s ? 1 : 0);
  const lines = [];
  lines.push(`# Staging gate report`, '');
  lines.push(`- Run: \`${runId}\``);
  lines.push(`- Target: ${target.app} / ${target.api}`);
  lines.push(`- Started: ${startedAt}  Finished: ${finishedAt}`);
  lines.push(`- Result: **${count('failed') === 0 ? 'PASS' : 'FAIL'}** — ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped`, '');
  for (const n of notes) lines.push(`> ${n}`, '');
  lines.push('| # | Area | Feature (test) | Result | Time | Screenshot | Failure / product finding |');
  lines.push('|---|---|---|---|---|---|---|');
  let i = 0;
  const row = (area, title, status, ms, shot, detail) => {
    i++;
    const mark = status === 'passed' ? 'PASS' : status === 'failed' ? '**FAIL**' : status.toUpperCase();
    lines.push(`| ${i} | ${cell(area)} | ${cell(title)} | ${mark} | ${ms ? `${(ms / 1000).toFixed(1)}s` : ''} | ${shot ? `\`${cell(path.relative(ROOT, shot))}\`` : '—'} | ${cell(detail)} |`);
  };
  if (health) row('API', 'GET /health/ready', health.status, health.ms, '', health.status === 'passed' ? '' : health.error);
  for (const r of all) {
    const f = findings[r.title];
    let detail = '';
    if (r.status === 'failed') {
      detail = f ? `FINDING: ${f.finding} Root cause: ${f.rootCause}` : r.error;
    } else if (r.status === 'passed' && f) {
      detail = `(recorded finding no longer reproduces: ${f.finding})`;
    }
    if (r.cleanup) detail = `${detail}${detail ? ' ' : ''}[cleanup left: ${r.cleanup}]`;
    row(r.kind === 'cli' ? `CLI ${r.suite}` : r.suite, r.title, r.status, r.ms, r.screenshot, detail);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * The packages under `dir`, by npm name: where each lives, its built entry
 * (main, else the first bin, else dist/index.js), whether it has a build
 * script, and which of its dependencies are packages of this repo.
 */
function readLocalPackages(dir) {
  const found = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name, 'package.json');
    if (!e.isDirectory() || !fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!json.name) continue;
    const bin = typeof json.bin === 'string' ? json.bin : Object.values(json.bin || {})[0];
    found[json.name] = {
      name: json.name,
      dir: path.join(dir, e.name),
      entry: path.join(dir, e.name, json.main || bin || 'dist/index.js'),
      hasBuildScript: !!json.scripts?.build,
      deps: Object.keys({ ...json.dependencies, ...json.peerDependencies }),
    };
  }
  for (const p of Object.values(found)) p.localDeps = p.deps.filter((d) => found[d]);
  return found;
}

/** `roots` and every local package they need, each after its dependencies. */
function buildOrder(pkgs, roots) {
  const order = [];
  const state = {};
  const visit = (name, trail) => {
    if (state[name] === 'done') return;
    if (state[name] === 'visiting') throw new Error(`dependency cycle: ${[...trail, name].join(' -> ')}`);
    if (!pkgs[name]) throw new Error(`unknown local package ${name}`);
    state[name] = 'visiting';
    for (const dep of pkgs[name].localDeps) visit(dep, [...trail, name]);
    state[name] = 'done';
    order.push(name);
  };
  for (const r of roots) visit(r, []);
  return order;
}

module.exports = { playwrightRows, vitestRows, buildReport, firstLine, redact, readLocalPackages, buildOrder };

// ── the run ─────────────────────────────────────────────────────────

function qaEnv() {
  let dir = ROOT;
  for (let n = 0; n < 8; n++) {
    const file = path.join(dir, '.env.staging-qa.local');
    if (fs.existsSync(file)) {
      const out = {};
      for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) continue;
        const at = line.indexOf('=');
        out[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
      }
      return out;
    }
    if (path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  throw new Error('.env.staging-qa.local not found (ALMYTY_QA_*): the gate signs in as the QA user from it.');
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  return res.status ?? 1;
}

function log(s) {
  process.stdout.write(`\n[gate] ${s}\n`);
}

async function health(api) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${api}/health/ready`);
    const body = await res.text();
    return { status: res.ok ? 'passed' : 'failed', ms: Date.now() - t0, error: `${res.status} ${body.slice(0, 160)}` };
  } catch (err) {
    return { status: 'failed', ms: Date.now() - t0, error: err.message };
  }
}

function ensureInstalled(dir) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    log(`installing ${path.relative(ROOT, dir)}`);
    if (sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir }) !== 0) throw new Error(`npm ci failed in ${dir}`);
  }
}

function runPlaywright(env) {
  ensureInstalled(FRONTEND);
  const args = [path.join(FRONTEND, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--config=playwright.staging.config.ts'];
  if (process.env.GATE_GREP) args.push(`--grep=${process.env.GATE_GREP}`);
  log('staging Playwright suite');
  const file = path.join(GATE_DIR, 'playwright-results.json');
  fs.rmSync(file, { force: true });
  const code = sh(process.execPath, args, { cwd: FRONTEND, env });
  const rows = fs.existsSync(file) ? playwrightRows(JSON.parse(fs.readFileSync(file, 'utf8'))) : [];
  // A suite that could not load (a syntax error, a failed global setup)
  // runs no test; that is a failure, never an empty pass.
  if (code !== 0 && !rows.some((r) => r.status === 'failed')) {
    rows.push({ suite: 'setup', title: 'staging Playwright suite ran', status: 'failed', ms: 0, screenshot: '', error: `playwright exited ${code} with no failed test: see its output` });
  }
  if (rows.length === 0) {
    rows.push({ suite: 'setup', title: 'staging Playwright suite ran', status: 'failed', ms: 0, screenshot: '', error: 'no test ran' });
  }
  return rows;
}

/** Sign the CLI in as the QA user through `almyty login`'s real browser flow; returns the HOME holding its credentials. */
async function cliLogin(qa, startedAt) {
  const { createRequire } = require('module');
  const { chromium } = createRequire(path.join(FRONTEND, 'package.json'))('@playwright/test');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'almyty-gate-home-'));
  const child = spawn(process.execPath, [
    path.join(PACKAGES, 'auth-cli', 'dist', 'index.js'), 'login', '--no-browser',
    `--frontend=${qa.app}`, `--api=${qa.api}`,
  ], { env: { ...process.env, HOME: home, USERPROFILE: home, ALMYTY_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const loginUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`almyty login printed no URL: ${out.slice(0, 300)}`)), 30_000);
    const onData = (d) => {
      out += d.toString();
      // Read the URL only once its line is complete (output arrives in chunks).
      const m = /Waiting for you/.test(out) && out.match(/https?:\/\/\S+\/cli-login\?\S+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ storageState: path.join(GATE_DIR, '.auth', 'qa.json') });
    const page = await context.newPage();
    await page.goto(loginUrl);
    // The QA user is in several organizations: wait until the page has
    // loaded them and offers the picker, as a person would see it.
    const picker = page.locator('#cli-organization');
    await picker.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('#cli-organization option').length > 1);
    await picker.selectOption({ label: qa.org });
    await page.getByRole('button', { name: 'Connect CLI' }).click();
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 60_000))]);
    if (code !== 0) {
      fs.mkdirSync(path.join(GATE_DIR, 'shots'), { recursive: true });
      await page.screenshot({ path: path.join(GATE_DIR, 'shots', 'cli-login.png') }).catch(() => {});
      child.kill();
      const last = out.trim().split('\n').filter((l) => l.trim()).pop() || '';
      throw new Error(`almyty login did not finish (${code}): ${last.trim().slice(0, 200)}`);
    }
  } finally {
    await browser.close();
  }
  return home;
}

/** Revoke the API keys `almyty login` minted during this run. */
async function revokeCliKeys(qa, startedAt) {
  const { createRequire } = require('module');
  const { request } = createRequire(path.join(FRONTEND, 'package.json'))('@playwright/test');
  const ctx = await request.newContext({ baseURL: qa.api, storageState: path.join(GATE_DIR, '.auth', 'qa.json') });
  try {
    const body = await (await ctx.get('/auth/api-keys')).json();
    const keys = Array.isArray(body.data) ? body.data : body.data?.keys || body.data?.apiKeys || [];
    for (const k of keys) {
      if (/^CLI login/.test(k.name || '') && Date.parse(k.createdAt) >= Date.parse(startedAt) - 60_000) {
        await ctx.delete(`/auth/api-keys/${k.id}`);
      }
    }
  } finally {
    await ctx.dispose();
  }
}

/**
 * Build the CLI packages and every package of this repo they depend on
 * (@almyty/client first), dependencies before dependants. Each local
 * dependency is linked into the dependant's node_modules, so the smoke
 * tests run this checkout's code, not a published copy -- and a link left
 * by an earlier install never points at a package with no dist.
 */
function buildLocalPackages(roots) {
  const pkgs = readLocalPackages(PACKAGES);
  for (const name of buildOrder(pkgs, roots.map((dir) => dirToName(pkgs, dir)))) {
    const pkg = pkgs[name];
    ensureInstalled(pkg.dir);
    for (const dep of pkg.localDeps) {
      const link = path.join(pkg.dir, 'node_modules', ...dep.split('/'));
      const target = pkgs[dep].dir;
      let current = null;
      try { current = fs.realpathSync(link); } catch { /* missing */ }
      if (current !== fs.realpathSync(target)) {
        fs.rmSync(link, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(path.relative(path.dirname(link), target), link, 'dir');
      }
    }
    if (needsBuild(pkg)) {
      log(`building ${path.relative(ROOT, pkg.dir)}`);
      const args = pkg.hasBuildScript ? ['run', 'build'] : ['exec', '--', 'tsc'];
      if (sh('npm', args, { cwd: pkg.dir }) !== 0) throw new Error(`build failed: ${path.basename(pkg.dir)}`);
    }
  }
}

function dirToName(pkgs, dir) {
  const hit = Object.values(pkgs).find((p) => path.basename(p.dir) === dir);
  if (!hit) throw new Error(`no package in packages/${dir}`);
  return hit.name;
}

/** The entry is missing, or a source file is newer than it. */
function needsBuild(pkg) {
  if (!fs.existsSync(pkg.entry)) return true;
  const built = fs.statSync(pkg.entry).mtimeMs;
  const src = path.join(pkg.dir, 'src');
  if (!fs.existsSync(src)) return false;
  const stack = [src];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (fs.statSync(p).mtimeMs > built) return true;
    }
  }
  return false;
}

async function runCli(qa, startedAt, notes) {
  buildLocalPackages(CLI_PACKAGES);
  const tests = path.join(PACKAGES, 'cli-tests');
  ensureInstalled(tests);
  log('CLI login as the QA user');
  let home;
  try {
    home = await cliLogin(qa, startedAt);
  } catch (err) {
    notes.push(`CLI login failed, CLI smoke tests not run: ${err.message}`);
    return [{ suite: 'login', title: 'almyty login as the QA user (browser flow)', status: 'failed', ms: 0, screenshot: '', error: err.message }];
  }
  const rows = [{ suite: 'login', title: 'almyty login as the QA user (browser flow)', status: 'passed', ms: 0, screenshot: '', error: '' }];
  const out = path.join(GATE_DIR, 'cli-results.json');
  try {
    log('CLI smoke tests');
    sh(process.execPath, [path.join(tests, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=default', '--reporter=json', `--outputFile=${out}`], {
      cwd: tests,
      env: { ...process.env, RUN_CLI_SMOKE: '1', HOME: home, USERPROFILE: home, ALMYTY_TOKEN: '' },
    });
    if (fs.existsSync(out)) rows.push(...vitestRows(JSON.parse(fs.readFileSync(out, 'utf8'))));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    await revokeCliKeys(qa, startedAt).catch((err) => notes.push(`could not revoke the CLI login key: ${err.message}`));
  }
  return rows;
}

async function main() {
  const env = qaEnv();
  const qa = {
    app: (env.ALMYTY_QA_APP_URL || 'https://app.staging.almyty.com').replace(/\/$/, ''),
    api: (env.ALMYTY_QA_API_URL || 'https://api.staging.almyty.com').replace(/\/$/, ''),
    org: env.ALMYTY_QA_ORG || process.env.ALMYTY_QA_ORG || 'Northwind AI',
  };
  const only = (process.env.GATE_ONLY || 'health,playwright,cli').split(',');
  const startedAt = new Date().toISOString();
  const runId = process.env.GATE_RUN_ID || startedAt.replace(/[-:T]/g, '').slice(2, 14);
  const childEnv = { ...process.env, GATE_RUN_ID: runId };
  fs.mkdirSync(GATE_DIR, { recursive: true });
  const notes = [];

  const h = only.includes('health') ? await health(qa.api) : null;
  // Playwright's global setup signs the QA user in and saves the session the CLI login reuses.
  const browser = only.includes('playwright') ? runPlaywright(childEnv) : [];
  let cli = [];
  if (only.includes('cli')) {
    try {
      cli = await runCli(qa, startedAt, notes);
    } catch (err) {
      notes.push(`CLI smoke tests could not run: ${err.message}`);
      cli = [{ suite: 'setup', title: 'CLI smoke tests', status: 'failed', ms: 0, screenshot: '', error: err.message }];
    }
  }

  const findings = fs.existsSync(FINDINGS) ? JSON.parse(fs.readFileSync(FINDINGS, 'utf8')) : {};
  const md = buildReport({
    runId, startedAt, finishedAt: new Date().toISOString(), target: qa, health: h, browser, cli, findings, notes,
  });
  fs.writeFileSync(REPORT, md);
  fs.mkdirSync(path.join(GATE_DIR, 'history'), { recursive: true });
  fs.writeFileSync(path.join(GATE_DIR, 'history', `${runId}.md`), md);
  log(`report: ${path.relative(ROOT, REPORT)}`);
  const failed = [h, ...browser, ...cli].filter((r) => r && r.status === 'failed').length;
  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
