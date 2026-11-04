#!/usr/bin/env node
// Capture the CLI help screenshots in docs-site/public/screenshots/cli/.
//
// Each image is `$ <bin> --help` followed by what the binary prints, run
// with NO_COLOR=1 and HOME set to a placeholder that is rewritten to `~`
// (so no machine path is published), rendered with
// `freeze --window --language text`, and registered in the screenshot
// manifest through docs-site/scripts/record-screenshot.mjs.
//
//   node scripts/capture-cli-help.js --from npm --register
//       run the published package at each package.json version
//   node scripts/capture-cli-help.js --from repo --text
//       preview with the built binary in packages/<dir>/dist (npm run build
//       first); a local build is never registered
//   node scripts/capture-cli-help.js --from npm --verify
//       render, and fail unless every image matches the committed one byte
//       for byte (the recipe still reproduces what is in the repo)
//
//   --only auth,chat     a subset (ids below)
//   --stale              only the images whose manifest entry names another
//                        version than package.json (what a release changed)
//   --out <dir>          keep the .txt and .png renders there
//   --captured-at <iso>  what to record (default: now)
//
// Needs freeze (https://github.com/charmbracelet/freeze) on PATH for
// anything but --text. --text prints the text that would be rendered.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');

// id: the image is screenshots/cli/<id>-help.png.
const CLIS = [
  { id: 'agents', dir: 'agents-cli', title: 'Agents CLI' },
  { id: 'almyty', dir: 'almyty-cli', title: 'almyty CLI' },
  { id: 'auth', dir: 'auth-cli', title: 'Auth CLI' },
  { id: 'chat', dir: 'chat-cli', title: 'Chat CLI' },
  { id: 'mcp-server', dir: 'mcp-server', title: 'MCP server CLI' },
  { id: 'skills', dir: 'skills-cli', title: 'Skills CLI' },
];

const FREEZE_ARGS = ['--window', '--language', 'text'];

function readPackage(cli, root = repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages', cli.dir, 'package.json'), 'utf8'));
  const [bin, binPath] = typeof pkg.bin === 'string' ? [pkg.name.split('/').pop(), pkg.bin] : Object.entries(pkg.bin)[0];
  return { name: pkg.name, version: pkg.version, bin, binPath };
}

// What is rendered: the command line, then the output exactly as printed
// (a trailing blank line included), with the placeholder HOME shown as ~.
function helpText(bin, output, home) {
  return `$ ${bin} --help\n${output.split(home).join('~')}`;
}

function recordArgs(cli, pkg, image, capturedAt) {
  const where = 'the published binary';
  return [
    path.join(repoRoot, 'docs-site', 'scripts', 'record-screenshot.mjs'),
    '--image', image,
    '--path', `screenshots/cli/${cli.id}-help.png`,
    '--title', `${cli.title} ${pkg.version} help`,
    '--captured-at', capturedAt,
    '--package', `${pkg.name}@${pkg.version}`,
    '--command', `${pkg.bin} --help`,
    '--sources', `packages/${cli.dir}/src`,
    '--sources', `packages/${cli.dir}/package.json`,
    '--notes', `Rendered from ${where} using freeze. HOME set to a placeholder and normalized to ~ before rendering; no machine path published.`,
  ];
}

// The CLIs whose image's manifest entry names another package version than
// package.json: the ones a release has made out of date.
function staleClis(clis, manifest, root = repoRoot) {
  return clis.filter((cli) => {
    const pkg = readPackage(cli, root);
    const entry = manifest.screenshots.find((s) => s.path === `screenshots/cli/${cli.id}-help.png`);
    return !entry || !entry.source || entry.source.package !== `${pkg.name}@${pkg.version}`;
  });
}

module.exports = { CLIS, FREEZE_ARGS, readPackage, helpText, recordArgs, staleClis };

function fail(message) {
  console.error(`capture-cli-help: ${message}`);
  process.exit(1);
}

function sh(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  return r;
}

function main(argv) {
  const opts = { from: 'repo', only: null, out: null, register: false, verify: false, text: false, capturedAt: new Date().toISOString() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') opts.from = argv[++i];
    else if (a === '--only') opts.only = argv[++i].split(',');
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--captured-at') opts.capturedAt = argv[++i];
    else if (a === '--register') opts.register = true;
    else if (a === '--verify') opts.verify = true;
    else if (a === '--text') opts.text = true;
    else if (a === '--stale') opts.stale = true;
    else fail(`unknown argument ${a}`);
  }
  if (!['repo', 'npm'].includes(opts.from)) fail('--from is repo or npm');
  // docs-site/SCREENSHOTS.md: a published-cli capture comes from the
  // published package, never from source.
  if (opts.register && opts.from !== 'npm') fail('--register needs --from npm; a local build only previews');
  let clis = opts.only ? CLIS.filter((c) => opts.only.includes(c.id)) : CLIS;
  if (opts.only && clis.length !== opts.only.length) fail(`--only takes ${CLIS.map((c) => c.id).join(', ')}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs-site', 'public', 'screenshots', 'manifest.json'), 'utf8'));
  if (opts.stale) {
    clis = staleClis(clis, manifest);
    if (clis.length === 0) {
      console.log('capture-cli-help: every CLI help image already shows its package.json version');
      return;
    }
  }
  if (!opts.text && sh('freeze', ['--version']).status !== 0) fail('freeze is not on PATH');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-help-'));
  const out = opts.out || work;
  fs.mkdirSync(out, { recursive: true });
  // A fixed placeholder, so a run renders the same bytes on every machine.
  const home = path.join(work, 'home');
  fs.mkdirSync(home);

  let prefix = null;
  if (opts.from === 'npm') {
    prefix = path.join(work, 'npm');
    const specs = clis.map((c) => readPackage(c)).map((p) => `${p.name}@${p.version}`);
    const r = sh('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', ...specs], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) fail(`npm install ${specs.join(' ')} failed`);
  }

  const mismatched = [];

  for (const cli of clis) {
    const pkg = readPackage(cli);
    const bin = prefix
      ? path.join(prefix, 'node_modules', ...pkg.name.split('/'), pkg.binPath)
      : path.join(repoRoot, 'packages', cli.dir, pkg.binPath);
    if (!fs.existsSync(bin)) fail(`${bin} does not exist${prefix ? '' : ` (cd packages/${cli.dir} && npm ci && npm run build)`}`);
    const run = sh(process.execPath, [bin, '--help'], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', TERM: 'dumb', COLUMNS: '80', LANG: 'C.UTF-8' },
    });
    if (run.status !== 0) fail(`${pkg.bin} --help exited ${run.status}: ${run.stderr}`);
    const text = helpText(pkg.bin, run.stdout + run.stderr, home);
    if (opts.text) {
      process.stdout.write(`${text}\n`);
      continue;
    }

    const txt = path.join(out, `${cli.id}-help.txt`);
    const png = path.join(out, `${cli.id}-help.png`);
    fs.writeFileSync(txt, text);
    // The input file goes first: freeze reads no file given after its flags.
    const r = sh('freeze', [txt, ...FREEZE_ARGS, '--output', png], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0 || !fs.existsSync(png)) fail(`freeze failed for ${cli.id}: ${r.stderr || r.stdout}`);

    const sha = crypto.createHash('sha256').update(fs.readFileSync(png)).digest('hex');
    const entry = manifest.screenshots.find((s) => s.path === `screenshots/cli/${cli.id}-help.png`);
    const same = entry && entry.sha256 === sha;
    console.log(`${cli.id}: ${pkg.name}@${pkg.version} ${same ? 'matches the committed image' : 'differs from the committed image'} (${sha.slice(0, 12)})`);
    if (!same) mismatched.push(cli.id);

    if (opts.register) {
      const rec = sh(process.execPath, recordArgs(cli, pkg, png, opts.capturedAt), { stdio: 'inherit' });
      if (rec.status !== 0) fail(`record-screenshot failed for ${cli.id}`);
    }
  }

  if (!opts.out) fs.rmSync(work, { recursive: true, force: true });
  if (opts.verify && mismatched.length) fail(`not byte for byte: ${mismatched.join(', ')}`);
}

if (require.main === module) main(process.argv.slice(2));
