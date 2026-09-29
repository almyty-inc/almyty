#!/usr/bin/env node
/**
 * @almyty/connections was renamed to @almyty/credentials. This alias runs
 * the new package with the same arguments, so scripts and docs that name
 * the old package keep working; the old command names (connectors,
 * connect, disconnect) are still understood there.
 *
 * It has no dependencies on purpose: it asks npx for the current
 * @almyty/credentials, so installing the alias never pins an old CLI.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function credentialsCommand(argv) {
  return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['-y', '@almyty/credentials', ...argv] };
}

/** Run only as the bin itself, never when imported (a test, a bundler). */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const { command, args } = credentialsCommand(process.argv.slice(2));
  const result = spawnSync(command, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
