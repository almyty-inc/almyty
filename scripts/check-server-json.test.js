'use strict';

// node --test scripts/check-server-json.test.js

const test = require('node:test');
const assert = require('node:assert');
const { envRead, findings, check } = require('./check-server-json.js');

const pkg = { name: '@almyty/mcp-server', version: '1.5.16', mcpName: 'com.almyty/mcp-server' };
const server = (over = {}) => ({
  name: 'com.almyty/mcp-server',
  description: 'Use your almyty tools from any MCP client.',
  version: '1.5.16',
  packages: [{
    registryType: 'npm',
    identifier: '@almyty/mcp-server',
    version: '1.5.16',
    transport: { type: 'stdio' },
    environmentVariables: [{ name: 'ALMYTY_TOKEN' }, { name: 'ALMYTY_URL' }],
  }],
  ...over,
});
const read = new Set(['ALMYTY_TOKEN', 'ALMYTY_URL']);

test('the committed server.json agrees with the package', () => {
  assert.deepStrictEqual(check().problems, []);
});

test('a server.json that agrees has no findings', () => {
  assert.deepStrictEqual(findings(server(), pkg, read), []);
});

test('the name must match mcpName, which the registry uses to prove npm ownership', () => {
  assert.match(findings(server({ name: 'com.almyty/other' }), pkg, read).join('\n'), /does not match package.json mcpName/);
  assert.match(findings(server(), { ...pkg, mcpName: undefined }, read).join('\n'), /has no "mcpName"/);
});

test('both versions must match package.json', () => {
  const s = server({ version: '1.5.15' });
  s.packages[0].version = '1.5.15';
  const out = findings(s, pkg, read);
  assert.strictEqual(out.length, 2);
  assert.match(out.join('\n'), /server.json version 1.5.15/);
  assert.match(out.join('\n'), /npm package version 1.5.15/);
});

test('the description fits the registry limit', () => {
  assert.match(findings(server({ description: 'x'.repeat(101) }), pkg, read).join('\n'), /101 characters/);
});

test('the listed variables are exactly the ones the package reads', () => {
  const out = findings(server(), pkg, new Set(['ALMYTY_TOKEN', 'ALMYTY_MODE'])).join('\n');
  assert.match(out, /ALMYTY_MODE is read by the package but not listed/);
  assert.match(out, /ALMYTY_URL is listed in server.json but the package never reads it/);
});

test('a missing npm entry is reported', () => {
  assert.match(findings(server({ packages: [] }), pkg, read).join('\n'), /lists 0 npm packages/);
});

test('envRead finds process.env.ALMYTY_* reads, defaults included', () => {
  const src = 'const a = process.env.ALMYTY_MODE;\nfunction f(v = process.env.ALMYTY_DISCOVERY_WAIT_MS) {}\nprocess.env.HOME;';
  assert.deepStrictEqual([...envRead([src])].sort(), ['ALMYTY_DISCOVERY_WAIT_MS', 'ALMYTY_MODE']);
});
