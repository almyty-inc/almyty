#!/usr/bin/env node
/**
 * @almyty/cli — single installable almyty CLI.
 *
 *   npm install -g @almyty/cli
 *   almyty login
 *   almyty agents list
 *   almyty chat my-research-bot
 *   almyty skills install org/gateway
 *
 * The umbrella delegates each subcommand to a standalone @almyty/<thing>
 * package by spawning its bin. Each package can ALSO be invoked directly:
 *
 *   npx @almyty/auth login
 *   npx @almyty/agents list
 *   npx @almyty/chat my-research-bot
 *
 * The standalone packages and the umbrella stay in sync because they
 * share the same on-disk credentials store at ~/.almyty/credentials.json.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { VERSION } from './version.js';
import { EXIT } from './exit-codes.js';
import {
  SUBCOMMANDS,
  completionScript,
  helpText,
  isCompletionShell,
  suggestCommand,
  tourText,
  COMPLETION_SHELLS,
} from './commands.js';

const require = createRequire(import.meta.url);

function resolveBinPath(packageName: string): string | null {
  // Resolve the package's package.json to find its installation root,
  // then read the "bin" entry to find the actual script path.
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }

  const pkgRoot = dirname(pkgJsonPath);
  let pkg: any;
  try {
    pkg = require(pkgJsonPath);
  } catch {
    return null;
  }

  // bin can be a string or { name: path }
  let binRel: string | undefined;
  if (typeof pkg.bin === 'string') {
    binRel = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    // Take the first entry (or one matching the package name).
    const keys = Object.keys(pkg.bin);
    binRel = pkg.bin[keys[0]];
  }
  if (!binRel) {
    // Fall back to dist/index.js convention used by all almyty packages.
    binRel = (pkg.main as string | undefined) || 'dist/index.js';
  }

  const binAbs = join(pkgRoot, binRel as string);
  return existsSync(binAbs) ? binAbs : null;
}

function delegate(packageName: string, args: string[]): Promise<number> {
  const binPath = resolveBinPath(packageName);
  if (!binPath) {
    console.error(`Error: package ${packageName} is not installed.`);
    console.error(`  Install it with: npm install -g ${packageName}`);
    console.error(`  Or use:          npx ${packageName} ${args.join(' ')}`);
    return Promise.resolve(EXIT.ERROR);
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: 'inherit',
    });

    // Forward Ctrl-C / Ctrl-\ so the child can clean up properly.
    const forward = (sig: NodeJS.Signals) => {
      try {
        if (!child.killed) child.kill(sig);
      } catch {
        // best effort
      }
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    process.on('SIGHUP', forward);

    child.on('exit', (code, signal) => {
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
      process.removeListener('SIGHUP', forward);
      if (signal) {
        // Re-raise the signal so our exit code reflects it.
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? EXIT.OK);
    });

    child.on('error', (err) => {
      console.error(`Failed to launch ${packageName}: ${err.message}`);
      resolve(EXIT.ERROR);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Bare `almyty` shows a short tour, not the full reference.
  if (argv.length === 0) {
    console.log(tourText(VERSION));
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(helpText(VERSION));
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    console.log(VERSION);
    return;
  }
  if (argv[0] === 'completion') {
    const shell = argv[1];
    if (!shell || !isCompletionShell(shell)) {
      console.error(
        `Usage: almyty completion <${COMPLETION_SHELLS.join('|')}>`,
      );
      process.exit(EXIT.USAGE);
    }
    console.log(completionScript(shell));
    return;
  }

  const cmd = argv[0];
  const sub = SUBCOMMANDS[cmd];
  if (!sub) {
    console.error(`Unknown command: ${cmd}`);
    const suggestion = suggestCommand(cmd);
    if (suggestion) console.error(`Did you mean \`almyty ${suggestion}\`?`);
    console.error('Run `almyty help` for the list of commands.');
    // Usage error, not a generic failure: a script can tell a typo
    // apart from a command that ran and failed.
    process.exit(EXIT.USAGE);
  }

  const passthroughArgs = [...(sub.prefixArgs ?? []), ...argv.slice(1)];
  const code = await delegate(sub.pkg, passthroughArgs);
  process.exit(code);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(EXIT.ERROR);
});
