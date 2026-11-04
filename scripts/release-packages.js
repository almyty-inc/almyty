#!/usr/bin/env node
// Release tooling for the twelve @almyty/* packages (docs/releasing.md).
//
// They ship in lockstep as one Changesets `fixed` group (.changeset/config.json),
// so one version number covers all twelve.
//
//   node scripts/release-packages.js order
//       the publishable packages in dependency order, one directory per line
//
//   node scripts/release-packages.js version
//       the Changesets action's version script: `changeset version`, then
//       carry the new version into each package-lock.json and into the
//       runner-env Dockerfile's RUNNER_VERSION
//
//   node scripts/release-packages.js publish [--dry-run] [--provenance]
//                                            [--only <dir>] [--prerelease <id>]
//       build every package from this checkout in dependency order, each
//       against the in-repo build of the @almyty/* packages it depends on,
//       then publish the ones npm does not have yet, dependencies first.
//       Nothing is published unless every build passed. In the published
//       manifest each internal dependency is ^<the version it was built
//       against>. --prerelease next.42 publishes <version>-next.42 instead
//       (exact internal versions), for the `next` dist-tag.
//
//   node scripts/release-packages.js raise-ranges
//       after a release: raise every internal range to ^<released version>
//       and refresh each package-lock.json from npm
//
//   node scripts/release-packages.js pin-runner-env
//       after a release: point settings.json, the backend defaults and the
//       pre-pull DaemonSet at the pushed almyty/runner-env images for the
//       Dockerfile's RUNNER_VERSION, by digest
//
// Each command prints what it changed and exits 0 when there was nothing
// to do.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');

const INTERNAL_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Every publishable package under packages/, as { dir, abs, manifest }. */
function publishable(root = repoRoot) {
  const base = path.join(root, 'packages');
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, 'package.json')))
    .map((e) => ({ dir: e.name, abs: path.join(base, e.name), manifest: readJson(path.join(base, e.name, 'package.json')) }))
    .filter((p) => p.manifest.private !== true)
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The @almyty/* packages `pkg` needs at run time, by name. */
function internalDeps(pkg, names) {
  const deps = new Set();
  for (const field of INTERNAL_FIELDS) {
    for (const name of Object.keys(pkg.manifest[field] || {})) if (names.has(name)) deps.add(name);
  }
  return [...deps].sort();
}

/** Dependencies before dependents; ties in directory order. */
function order(pkgs) {
  const byName = new Map(pkgs.map((p) => [p.manifest.name, p]));
  const names = new Set(byName.keys());
  const done = new Set();
  const out = [];
  while (out.length < pkgs.length) {
    const ready = pkgs.filter((p) => !done.has(p.manifest.name) && internalDeps(p, names).every((d) => done.has(d)));
    if (ready.length === 0) {
      const left = pkgs.filter((p) => !done.has(p.manifest.name)).map((p) => p.manifest.name);
      throw new Error(`dependency cycle among ${left.join(', ')}`);
    }
    for (const p of ready) {
      done.add(p.manifest.name);
      out.push(p);
    }
  }
  return out;
}

/** Make each package-lock.json carry its package.json's version. */
function syncLocks(root = repoRoot) {
  const changed = [];
  for (const p of publishable(root)) {
    const lockPath = path.join(p.abs, 'package-lock.json');
    if (!fs.existsSync(lockPath)) continue;
    const lock = readJson(lockPath);
    const rootEntry = (lock.packages && lock.packages['']) || {};
    if (lock.version === p.manifest.version && rootEntry.version === p.manifest.version) continue;
    lock.version = p.manifest.version;
    if (lock.packages && lock.packages['']) lock.packages[''].version = p.manifest.version;
    writeJson(lockPath, lock);
    changed.push(`packages/${p.dir}/package-lock.json -> ${p.manifest.version}`);
  }
  return changed;
}

/** Point the runner-env Dockerfile at packages/runner's version. */
function syncRunnerEnvDockerfile(root = repoRoot) {
  const file = path.join(root, 'images', 'runner-env', 'Dockerfile');
  if (!fs.existsSync(file)) return [];
  const version = readJson(path.join(root, 'packages', 'runner', 'package.json')).version;
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/^ARG RUNNER_VERSION=\S+$/m, `ARG RUNNER_VERSION=${version}`);
  if (next === text) return [];
  fs.writeFileSync(file, next);
  return [`images/runner-env/Dockerfile RUNNER_VERSION -> ${version}`];
}

/**
 * Set every internal range to ^<that package's version> in the manifests
 * under `root`. Returns the directories it changed.
 */
function raiseRanges(root = repoRoot, { isPublished = () => true } = {}) {
  const pkgs = publishable(root);
  const versions = new Map(pkgs.map((p) => [p.manifest.name, p.manifest.version]));
  const changed = [];
  for (const p of pkgs) {
    let touched = false;
    for (const field of INTERNAL_FIELDS) {
      for (const name of Object.keys(p.manifest[field] || {})) {
        if (!versions.has(name)) continue;
        const want = `^${versions.get(name)}`;
        if (p.manifest[field][name] === want) continue;
        if (!isPublished(name, versions.get(name))) continue;
        p.manifest[field][name] = want;
        touched = true;
      }
    }
    if (touched) {
      writeJson(path.join(p.abs, 'package.json'), p.manifest);
      changed.push(p.dir);
    }
  }
  return changed;
}

/** The manifest a package is published with. */
function publishManifest(manifest, versions, { prerelease } = {}) {
  const out = structuredClone(manifest);
  if (prerelease) out.version = `${manifest.version}-${prerelease}`;
  for (const field of INTERNAL_FIELDS) {
    for (const name of Object.keys(out[field] || {})) {
      if (!versions.has(name)) continue;
      out[field][name] = prerelease ? `${versions.get(name)}-${prerelease}` : `^${versions.get(name)}`;
    }
  }
  return out;
}

// ── runner-env digests ────────────────────────────────────────────────
const REF = /almyty\/runner-env:([A-Za-z0-9_-]+?)-(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}/g;
const RUNNER_ENV_FILES = [
  'images/runner-env/settings.json',
  'backend/src/modules/hosted-runners/hosted-runner-settings.ts',
  'docs/design/hosted-runners/image-prepull.yaml',
];

const semver = (v) => v.split('.').map(Number);
const older = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/**
 * Rewrite every digest-pinned runner-env reference older than the
 * Dockerfile's RUNNER_VERSION to that version's pushed digest. `digestOf`
 * returns the digest of a tag, or null when it has not been pushed; if any
 * flavour has not, nothing is changed.
 */
function pinRunnerEnv(root = repoRoot, { digestOf }) {
  const dockerfile = fs.readFileSync(path.join(root, 'images', 'runner-env', 'Dockerfile'), 'utf8');
  const version = (/^ARG RUNNER_VERSION=(\S+)$/m.exec(dockerfile) || [])[1];
  const files = RUNNER_ENV_FILES.filter((f) => fs.existsSync(path.join(root, f)));
  const stale = new Map();
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(REF)) {
      if (older(m[2], version) < 0) stale.set(m[0], m[1]);
    }
  }
  if (stale.size === 0) return { version, changed: [], missing: [] };
  const replacement = new Map();
  const missing = [];
  for (const [ref, flavour] of stale) {
    const tag = `almyty/runner-env:${flavour}-${version}`;
    const digest = digestOf(tag);
    if (!digest) missing.push(tag);
    else replacement.set(ref, `${tag}@${digest}`);
  }
  if (missing.length) return { version, changed: [], missing: [...new Set(missing)] };
  const changed = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const next = text.replace(REF, (ref) => replacement.get(ref) || ref);
    if (next !== text) {
      fs.writeFileSync(path.join(root, f), next);
      changed.push(f);
    }
  }
  return { version, changed, missing };
}

module.exports = {
  publishable, internalDeps, order, syncLocks, syncRunnerEnvDockerfile,
  raiseRanges, publishManifest, pinRunnerEnv,
};

// ── commands ──────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  console.log(`$ ${[cmd, ...args].join(' ')}${opts.cwd ? `   (in ${path.relative(repoRoot, opts.cwd) || '.'})` : ''}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`release-packages: ${cmd} ${args.join(' ')} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
    process.exit(1);
  }
}

function isOnNpm(name, version) {
  const r = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === version;
}

function dockerDigest(tag) {
  const r = spawnSync('docker', ['buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const digest = JSON.parse(r.stdout).digest;
    return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

function cmdVersion() {
  run(path.join(repoRoot, 'node_modules', '.bin', 'changeset'), ['version'], { cwd: repoRoot });
  for (const line of [...syncLocks(), ...syncRunnerEnvDockerfile()]) console.log(line);
}

function cmdPublish(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const dryRun = argv.includes('--dry-run');
  const provenance = argv.includes('--provenance');
  const only = opt('--only');
  const prerelease = opt('--prerelease');
  const tag = opt('--tag') || (prerelease ? 'next' : null);

  const pkgs = order(publishable());
  const byName = new Map(pkgs.map((p) => [p.manifest.name, p]));
  const names = new Set(byName.keys());
  const versions = new Map(pkgs.map((p) => [p.manifest.name, p.manifest.version]));
  if (new Set(versions.values()).size !== 1) {
    console.error('release-packages: the packages are not at one version (node scripts/check-npm-lockstep.js)');
    process.exit(1);
  }
  if (only && prerelease) {
    // A prerelease pins its dependencies to the same prerelease, so it has
    // to publish all of them.
    console.error('release-packages: --prerelease publishes every package; drop --only');
    process.exit(1);
  }
  if (only && !pkgs.some((p) => p.dir === only)) {
    console.error(`release-packages: --only takes one of ${pkgs.map((p) => p.dir).join(', ')}`);
    process.exit(1);
  }

  // What to build: the selection and everything it depends on.
  const needed = new Set();
  const want = (p) => {
    if (needed.has(p.manifest.name)) return;
    needed.add(p.manifest.name);
    for (const d of internalDeps(p, names)) want(byName.get(d));
  };
  for (const p of pkgs) if (!only || p.dir === only) want(p);

  console.log(`release-packages: order ${pkgs.filter((p) => needed.has(p.manifest.name)).map((p) => p.dir).join(' -> ')}`);

  for (const p of pkgs.filter((x) => needed.has(x.manifest.name))) {
    console.log(`\n== build ${p.manifest.name}@${p.manifest.version}`);
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: p.abs });
    // The dependency as built from this checkout, where npm installed the
    // registry copy: the same overlay CI's package legs use.
    for (const d of internalDeps(p, names)) {
      const dep = byName.get(d);
      const target = path.join(p.abs, 'node_modules', ...d.split('/'));
      fs.rmSync(path.join(target, 'dist'), { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(path.join(dep.abs, 'dist'), path.join(target, 'dist'), { recursive: true });
      fs.copyFileSync(path.join(dep.abs, 'package.json'), path.join(target, 'package.json'));
      console.log(`linked packages/${dep.dir} (this checkout) into packages/${p.dir}/node_modules/${d}`);
    }
    run('npm', ['run', 'build'], { cwd: p.abs });
  }

  const published = [];
  for (const p of pkgs.filter((x) => (only ? x.dir === only : true))) {
    const manifest = publishManifest(p.manifest, versions, { prerelease });
    const spec = `${manifest.name}@${manifest.version}`;
    console.log(`\n== publish ${spec}`);
    if (isOnNpm(manifest.name, manifest.version)) {
      console.log(`${spec} is already on npm, skipping`);
      continue;
    }
    const manifestPath = path.join(p.abs, 'package.json');
    const original = fs.readFileSync(manifestPath, 'utf8');
    writeJson(manifestPath, manifest);
    try {
      // --ignore-scripts: publish exactly what was built above, against the
      // in-repo dependencies, instead of letting prepublishOnly rebuild.
      const args = ['publish', '--access', 'public', '--ignore-scripts'];
      if (provenance) args.push('--provenance');
      if (tag) args.push('--tag', tag);
      if (dryRun) args.push('--dry-run');
      run('npm', args, { cwd: p.abs });
      published.push(spec);
    } finally {
      if (dryRun || prerelease) fs.writeFileSync(manifestPath, original);
    }
  }
  console.log(`\nrelease-packages: ${dryRun ? 'would publish' : 'published'} ${published.length ? published.join(', ') : 'nothing'}`);
}

function cmdRaiseRanges() {
  const changed = raiseRanges(repoRoot, { isPublished: isOnNpm });
  for (const dir of changed) {
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(repoRoot, 'packages', dir) });
  }
  console.log(changed.length ? `raised internal ranges in ${changed.join(', ')}` : 'internal ranges already name the released version');
}

function cmdPinRunnerEnv() {
  const { version, changed, missing } = pinRunnerEnv(repoRoot, { digestOf: dockerDigest });
  if (missing.length) console.log(`runner-env ${version} not pushed yet (${missing.join(', ')}); references left alone`);
  else console.log(changed.length ? `pinned runner-env ${version} in ${changed.join(', ')}` : `runner-env references already at ${version}`);
}

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'order':
      for (const p of order(publishable())) console.log(p.dir);
      break;
    case 'version':
      cmdVersion();
      break;
    case 'publish':
      cmdPublish(rest);
      break;
    case 'raise-ranges':
      cmdRaiseRanges();
      break;
    case 'pin-runner-env':
      cmdPinRunnerEnv();
      break;
    default:
      console.error('usage: release-packages.js order|version|publish|raise-ranges|pin-runner-env');
      process.exit(2);
  }
}
