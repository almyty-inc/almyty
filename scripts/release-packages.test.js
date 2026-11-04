'use strict';

// node --test scripts/release-packages.test.js
//
// The parts of the release that decide what is published and in which
// order, against fixture trees: dependency order, the published manifest,
// the version PR's lockfile and Dockerfile sync, the post-release range
// raise and the runner-env digest pin. Building and `npm publish` are
// exercised with `node scripts/release-packages.js publish --dry-run`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rp = require('./release-packages.js');

const repo = path.join(__dirname, '..');

function tree(t, packages, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-packages-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  };
  for (const [dir, manifest] of Object.entries(packages)) {
    write(`packages/${dir}/package.json`, manifest);
    write(`packages/${dir}/package-lock.json`, {
      name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
      packages: { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies || {} } },
    });
  }
  for (const [rel, body] of Object.entries(extra)) write(rel, body);
  const json = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  const text = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  return { root, json, text };
}

const suite = (version = '1.5.8', range = '^1.5.8') => ({
  'almyty-cli': { name: '@almyty/cli', version, dependencies: { '@almyty/agents': range, '@almyty/auth': range, commander: '^14.0.0' } },
  'agents-cli': { name: '@almyty/agents', version, dependencies: { '@almyty/client': range } },
  'auth-cli': { name: '@almyty/auth', version },
  client: { name: '@almyty/client', version },
  'cli-tests': { name: '@almyty/cli-tests', version: '0.0.0', private: true, dependencies: { '@almyty/cli': range } },
});

test('the repository publishes dependencies first: client before its users, almyty-cli last', () => {
  const order = rp.order(rp.publishable(repo)).map((p) => p.dir);
  assert.strictEqual(order.length, 12);
  const at = (d) => order.indexOf(d);
  for (const user of ['acp-server', 'agents-cli', 'chat-cli', 'credentials-cli', 'mcp-server', 'models-cli', 'runner', 'skills-cli']) {
    assert.ok(at('client') < at(user), `client must publish before ${user}`);
  }
  assert.strictEqual(order.at(-1), 'almyty-cli');
});

test('order is dependencies first, private packages left out', (t) => {
  const { root } = tree(t, suite());
  assert.deepStrictEqual(rp.order(rp.publishable(root)).map((p) => p.dir), ['auth-cli', 'client', 'agents-cli', 'almyty-cli']);
});

test('a dependency cycle is refused', (t) => {
  const { root } = tree(t, {
    a: { name: '@almyty/a', version: '1.0.0', dependencies: { '@almyty/b': '^1.0.0' } },
    b: { name: '@almyty/b', version: '1.0.0', peerDependencies: { '@almyty/a': '^1.0.0' } },
  });
  assert.throws(() => rp.order(rp.publishable(root)), /dependency cycle among @almyty\/a, @almyty\/b/);
});

test('the published manifest names each internal dependency at the version it was built against', () => {
  const versions = new Map([['@almyty/client', '1.5.9'], ['@almyty/agents', '1.5.9']]);
  const manifest = { name: '@almyty/agents', version: '1.5.9', dependencies: { '@almyty/client': '^1.5.8', ink: '^8.0.0' } };
  const out = rp.publishManifest(manifest, versions);
  assert.deepStrictEqual(out.dependencies, { '@almyty/client': '^1.5.9', ink: '^8.0.0' });
  assert.strictEqual(manifest.dependencies['@almyty/client'], '^1.5.8', 'the committed manifest is not changed');
});

test('a prerelease pins its internal dependencies to the same prerelease', () => {
  const versions = new Map([['@almyty/client', '1.5.9']]);
  const out = rp.publishManifest({ name: '@almyty/chat', version: '1.5.9', dependencies: { '@almyty/client': '^1.5.8' } }, versions, { prerelease: 'next.42' });
  assert.strictEqual(out.version, '1.5.9-next.42');
  assert.strictEqual(out.dependencies['@almyty/client'], '1.5.9-next.42');
});

test('the version PR carries the new version into every lockfile and the runner-env Dockerfile', (t) => {
  const pkgs = suite('1.5.9');
  pkgs.runner = { name: '@almyty/runner', version: '1.5.9' };
  const { root, json, text } = tree(t, pkgs, { 'images/runner-env/Dockerfile': 'FROM scratch AS runner-pkg\nARG RUNNER_VERSION=1.5.8\n' });
  for (const dir of ['client', 'runner']) {
    const lock = json(`packages/${dir}/package-lock.json`);
    lock.version = '1.5.8';
    lock.packages[''].version = '1.5.8';
    fs.writeFileSync(path.join(root, 'packages', dir, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  }
  assert.deepStrictEqual(rp.syncLocks(root), ['packages/client/package-lock.json -> 1.5.9', 'packages/runner/package-lock.json -> 1.5.9']);
  for (const dir of ['client', 'runner']) {
    const lock = json(`packages/${dir}/package-lock.json`);
    assert.strictEqual(lock.version, '1.5.9');
    assert.strictEqual(lock.packages[''].version, '1.5.9');
  }
  assert.deepStrictEqual(rp.syncRunnerEnvDockerfile(root), ['images/runner-env/Dockerfile RUNNER_VERSION -> 1.5.9']);
  assert.match(text('images/runner-env/Dockerfile'), /^ARG RUNNER_VERSION=1\.5\.9$/m);
  assert.deepStrictEqual(rp.syncLocks(root), [], 'a second run changes nothing');
  assert.deepStrictEqual(rp.syncRunnerEnvDockerfile(root), []);
});

test('after the release, internal ranges move to the released version, but only once npm has it', (t) => {
  const { root, json } = tree(t, suite('1.5.9', '^1.5.8'));
  const onNpm = new Set(['@almyty/auth@1.5.9', '@almyty/client@1.5.9']);
  const changed = rp.raiseRanges(root, { isPublished: (n, v) => onNpm.has(`${n}@${v}`) });
  assert.deepStrictEqual(changed, ['agents-cli', 'almyty-cli']);
  assert.deepStrictEqual(json('packages/almyty-cli/package.json').dependencies, { '@almyty/agents': '^1.5.8', '@almyty/auth': '^1.5.9', commander: '^14.0.0' });
  assert.strictEqual(json('packages/agents-cli/package.json').dependencies['@almyty/client'], '^1.5.9');
  assert.strictEqual(json('packages/cli-tests/package.json').dependencies['@almyty/cli'], '^1.5.8', 'private packages are left alone');
  onNpm.add('@almyty/agents@1.5.9');
  assert.deepStrictEqual(rp.raiseRanges(root, { isPublished: (n, v) => onNpm.has(`${n}@${v}`) }), ['almyty-cli']);
  assert.deepStrictEqual(rp.raiseRanges(root, { isPublished: () => true }), []);
});

const D = (c) => `sha256:${c.repeat(64)}`;
function runnerEnv(t, refVersion = '1.5.7') {
  const ref = (f) => `almyty/runner-env:${f}-${refVersion}@${D('a')}`;
  return tree(t, {}, {
    'images/runner-env/Dockerfile': 'ARG RUNNER_VERSION=1.5.8\n',
    'images/runner-env/settings.json': { images: { standard: ref('standard'), 'standard-browser': ref('standard-browser') } },
    'backend/src/modules/hosted-runners/hosted-runner-settings.ts': `images: {\n    standard: '${ref('standard')}',\n    'standard-browser': '${ref('standard-browser')}',\n  },\n`,
    'docs/design/hosted-runners/image-prepull.yaml': `        - name: pull\n          image: ${ref('standard')}\n`,
  });
}

test('the runner-env references move to the pushed digests of the Dockerfile version', (t) => {
  const { root, json, text } = runnerEnv(t);
  const asked = [];
  const result = rp.pinRunnerEnv(root, { digestOf: (tag) => (asked.push(tag), tag.includes('browser') ? D('c') : D('b')) });
  assert.deepStrictEqual(asked.sort(), ['almyty/runner-env:standard-1.5.8', 'almyty/runner-env:standard-browser-1.5.8']);
  assert.deepStrictEqual(result.changed, [
    'images/runner-env/settings.json',
    'backend/src/modules/hosted-runners/hosted-runner-settings.ts',
    'docs/design/hosted-runners/image-prepull.yaml',
  ]);
  assert.deepStrictEqual(json('images/runner-env/settings.json').images, {
    standard: `almyty/runner-env:standard-1.5.8@${D('b')}`,
    'standard-browser': `almyty/runner-env:standard-browser-1.5.8@${D('c')}`,
  });
  assert.match(text('backend/src/modules/hosted-runners/hosted-runner-settings.ts'), new RegExp(`standard: 'almyty/runner-env:standard-1\\.5\\.8@${D('b')}'`));
  assert.match(text('docs/design/hosted-runners/image-prepull.yaml'), new RegExp(`image: almyty/runner-env:standard-1\\.5\\.8@${D('b')}`));
});

test('nothing moves until every flavour has been pushed', (t) => {
  const { root, text } = runnerEnv(t);
  const before = text('images/runner-env/settings.json');
  const result = rp.pinRunnerEnv(root, { digestOf: (tag) => (tag.includes('browser') ? null : D('b')) });
  assert.deepStrictEqual(result.changed, []);
  assert.deepStrictEqual(result.missing, ['almyty/runner-env:standard-browser-1.5.8']);
  assert.strictEqual(text('images/runner-env/settings.json'), before);
});

test('references already at the Dockerfile version are not looked up again', (t) => {
  const { root } = runnerEnv(t, '1.5.8');
  const result = rp.pinRunnerEnv(root, { digestOf: () => assert.fail('no lookup expected') });
  assert.deepStrictEqual(result, { version: '1.5.8', changed: [], missing: [] });
});
