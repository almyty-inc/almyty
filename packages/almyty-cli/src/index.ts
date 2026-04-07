#!/usr/bin/env node
/**
 * @almyty/cli — single installable almyty CLI.
 *
 *   npm install -g @almyty/cli
 *   almyty login
 *   almyty agents list
 *   almyty chat my-research-bot
 *   almyty skills install @org/gateway
 *   almyty mcp <args>
 *
 * The umbrella delegates each subcommand to a standalone @almyty/<thing>
 * package by spawning its bin. Each package can ALSO be invoked directly:
 *
 *   npx @almyty/auth login
 *   npx @almyty/agents list
 *   npx @almyty/chat my-research-bot
 *   …
 *
 * The standalone packages and the umbrella stay in sync because they
 * share the same on-disk credentials store at ~/.almyty/credentials.json.
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const require = createRequire(import.meta.url);
const VERSION = '0.1.0';

interface Subcommand {
  /** package name to delegate to */
  pkg: string;
  /**
   * Optional argv prefix injected before the user-supplied args.
   * Used for top-level shortcuts like `almyty login` -> `@almyty/auth login`.
   */
  prefixArgs?: string[];
  /** Short help line shown by `almyty help` */
  help: string;
}

/**
 * Top-level subcommand routing table. Order = display order in help.
 */
const SUBCOMMANDS: Record<string, Subcommand> = {
  // Auth shortcuts at top level (gh-style: `almyty login` not `almyty auth login`)
  login: { pkg: '@almyty/auth', prefixArgs: ['login'], help: 'Browser-based login' },
  logout: { pkg: '@almyty/auth', prefixArgs: ['logout'], help: 'Remove stored credentials' },
  whoami: { pkg: '@almyty/auth', prefixArgs: ['whoami'], help: 'Show the current identity' },
  auth: { pkg: '@almyty/auth', help: 'Auth subcommands (login/logout/whoami)' },

  // Domain CLIs
  agents: { pkg: '@almyty/agents', help: 'List, run, and inspect agents' },
  chat: { pkg: '@almyty/chat', help: 'Interactive chat REPL with an agent' },
  skills: { pkg: '@almyty/skills', help: 'Install API skills into AI coding agents' },
  mcp: { pkg: '@almyty/mcp-server', help: 'Run the MCP server proxy' },
};

function printHelp(): void {
  console.log(`
almyty CLI v${VERSION}

Usage:
  almyty <command> [args]

Auth:
  login                 Browser-based login (writes ~/.almyty/credentials.json)
  logout                Remove stored credentials
  whoami                Show the currently logged-in identity
  auth <subcommand>     Pass-through to @almyty/auth

Agents:
  agents list                       List agents in your organization
  agents get <ref>                  Show details for one agent
  agents run <ref> [--input ...]    Invoke / start a run
  agents runs <ref>                 List recent runs
  agents cancel <ref> <runId>       Cancel an in-flight run

Chat:
  chat                  Interactive REPL — pick an agent from a menu
  chat <ref>            Start chatting with that agent

Skills:
  skills install <ref>              Install skills into local AI coding agents
  skills list [ref]                 List available skills
  skills daemon                     Sync skills on a schedule
  skills run <ref>                  Execute a skill once

MCP:
  mcp <args>            Run the MCP server proxy

Other:
  help, --help          Show this help
  version, --version    Show version

Each subcommand maps to a standalone npm package. You can invoke any
of them directly with npx:

  npx @almyty/auth login
  npx @almyty/agents list
  npx @almyty/chat my-research-bot
  npx @almyty/skills install @org/gateway
`);
}

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
    console.error(`  Or use:           npx ${packageName} ${args.join(' ')}`);
    return Promise.resolve(1);
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
      resolve(code ?? 0);
    });

    child.on('error', (err) => {
      console.error(`Failed to launch ${packageName}: ${err.message}`);
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printHelp();
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    console.log(VERSION);
    return;
  }

  const cmd = argv[0];
  const sub = SUBCOMMANDS[cmd];
  if (!sub) {
    console.error(`Unknown command: ${cmd}`);
    console.error(`Run \`almyty help\` for the list of commands.`);
    process.exit(1);
  }

  const passthroughArgs = [...(sub.prefixArgs ?? []), ...argv.slice(1)];
  const code = await delegate(sub.pkg, passthroughArgs);
  process.exit(code);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
