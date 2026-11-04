'use strict';

// node --test scripts/check-dev-proxy.test.js
//
// Runs check-dev-proxy.js against fixture controllers and a fixture
// vite.config.ts. The script resolves the repo from its own location, so
// it is copied into the fixture's scripts/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = 'check-dev-proxy.js';

const rule = (prefix) => `    '/${prefix}': {\n      target: apiTarget,\n      changeOrigin: true,\n    },\n`;
const vite = (prefixes, extra = '') =>
  `export default defineConfig({\n  server: {\n    proxy: {\n${prefixes.map(rule).join('')}${extra}    },\n  },\n});\n`;

function fixture(t, { controllers, proxied, extra }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-proxy-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write(`scripts/${SCRIPT}`, fs.readFileSync(path.join(__dirname, SCRIPT)));
  fs.mkdirSync(path.join(root, 'backend', 'src'), { recursive: true });
  for (const [rel, body] of Object.entries(controllers)) write(rel, body);
  write('frontend/vite.config.ts', vite(proxied, extra));
  return root;
}

function run(root) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', SCRIPT)], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

const runners = { 'backend/src/runner/runner.controller.ts': "@Controller('runners')\nexport class RunnerController {}\n" };

test('the repository passes', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, SCRIPT)], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('every prefix with a rule passes', (t) => {
  const r = run(fixture(t, { controllers: runners, proxied: ['runners'] }));
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /all 1 API prefixes are proxied/);
});

test('a controller prefix with no rule fails and is named', (t) => {
  const r = run(fixture(t, {
    controllers: { ...runners, 'backend/src/agents/agents.controller.ts': "@Controller('agents/:id')\nclass A {}\n" },
    proxied: ['runners'],
  }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^\s+\/agents$/m);
});

test('the object form @Controller({ path }) is read too', (t) => {
  const r = run(fixture(t, {
    controllers: { 'backend/src/mcp/mcp.controller.ts': "@Controller({ version: '1', path: 'mcp' })\nclass M {}\n" },
    proxied: [],
  }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^\s+\/mcp$/m);
});

test('a bare @Controller() contributes each route\'s first segment', (t) => {
  const r = run(fixture(t, {
    controllers: { 'backend/src/credentials/keys.controller.ts': "@Controller()\nclass K {\n  @Get('access-keys/:id')\n  get() {}\n}\n" },
    proxied: [],
  }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^\s+\/access-keys$/m);
});

test('EE controllers outside backend/src are checked', (t) => {
  const r = run(fixture(t, {
    controllers: { ...runners, 'backend/ee/rbac/rbac.controller.ts': "@Controller('rbac')\nclass R {}\n" },
    proxied: ['runners'],
  }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^\s+\/rbac$/m);
});

test('gateway routes need the gateway-path rule', (t) => {
  const controllers = {
    ...runners,
    'backend/src/gateways/unified.controller.ts': "@Controller()\nclass U {\n  @All(':org/:gateway/*')\n  serve() {}\n}\n",
  };
  const without = run(fixture(t, { controllers, proxied: ['runners'] }));
  assert.strictEqual(without.code, 1, without.out);
  assert.match(without.out, /gateway routes with no dev-proxy rule/);

  const withRule = run(fixture(t, { controllers, proxied: ['runners'], extra: '    [GATEWAY_PATHS_RULE]: {\n      target: apiTarget,\n    },\n' }));
  assert.strictEqual(withRule.code, 0, withRule.out);
});

test('no controllers at all fails rather than passing vacuously', (t) => {
  const r = run(fixture(t, { controllers: {}, proxied: ['runners'] }));
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /found no controllers/);
});
