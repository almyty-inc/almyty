import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { credentialsCommand } from '../bin/almyty-connections.js';

test('runs @almyty/credentials with the same arguments', () => {
  const { args } = credentialsCommand(['list', '--json']);
  assert.deepEqual(args, ['-y', '@almyty/credentials', 'list', '--json']);
});

test('keeps no dependency that could pin an old CLI', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, '@almyty/connections');
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(pkg.bin, { 'almyty-connections': 'bin/almyty-connections.js' });
});
