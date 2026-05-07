#!/usr/bin/env node
/**
 * almyty-runner CLI.
 *
 *   almyty-runner start [--name X] [--label k=v]... [--config path] [--url URL]
 *   almyty-runner status
 *   almyty-runner stop
 *
 * Auth: ALMYTY_TOKEN env or ~/.almyty/credentials.json (run
 * `npx @almyty/auth login` first if neither is configured).
 */

import { RunnerDaemon, readStatus, stopDaemon } from './daemon.js';
import { RUNNER_VERSION } from './runtime-info.js';

interface ParsedFlags {
  command: 'start' | 'status' | 'stop' | 'help' | 'version';
  name?: string;
  url?: string;
  configPath?: string;
  labels?: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedFlags {
  const args = argv.slice(2);
  if (args.length === 0) return { command: 'help' };
  const command = args[0];
  if (command === '--version' || command === '-v') return { command: 'version' };
  if (command === '--help' || command === '-h') return { command: 'help' };

  if (!['start', 'status', 'stop', 'help', 'version'].includes(command)) {
    return { command: 'help' };
  }

  const flags: ParsedFlags = { command: command as ParsedFlags['command'] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' && args[i + 1]) { flags.name = args[++i]; continue; }
    if (a === '--config' && args[i + 1]) { flags.configPath = args[++i]; continue; }
    if (a === '--url' && args[i + 1]) { flags.url = args[++i]; continue; }
    if (a === '--label' && args[i + 1]) {
      const kv = args[++i];
      const eq = kv.indexOf('=');
      if (eq <= 0) {
        process.stderr.write(`--label expects key=value, got: ${kv}\n`);
        process.exit(2);
      }
      flags.labels = flags.labels ?? {};
      flags.labels[kv.slice(0, eq)] = kv.slice(eq + 1);
      continue;
    }
    if (a === '--help' || a === '-h') { flags.command = 'help'; return flags; }
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(`almyty-runner v${RUNNER_VERSION}

Usage:
  almyty-runner start [options]    Register and run the daemon
  almyty-runner status             Show local daemon status
  almyty-runner stop               Send SIGTERM to the local daemon

Options for start:
  --name <name>           Runner name (matches [a-zA-Z0-9_-]{1,64})
  --label key=value       Add a routing label; repeat for multiple
  --config <path>         Path to a JSON config file (overrides global+project)
  --url <backend-url>     Override backend URL (e.g. https://api.almyty.com)

Auth:
  ALMYTY_TOKEN env or ~/.almyty/credentials.json (\`npx @almyty/auth login\`).
`);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv);
  switch (flags.command) {
    case 'version': process.stdout.write(`${RUNNER_VERSION}\n`); return;
    case 'help': printHelp(); return;
    case 'status': {
      const status = readStatus();
      if (!status) {
        process.stdout.write('runner: not running\n');
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      return;
    }
    case 'stop': {
      const ok = stopDaemon();
      if (!ok) {
        process.stdout.write('runner: not running\n');
        process.exit(1);
      }
      process.stdout.write('runner: stop signal sent\n');
      return;
    }
    case 'start': {
      const daemon = new RunnerDaemon();
      try {
        await daemon.start({
          name: flags.name,
          labels: flags.labels,
          backendUrl: flags.url,
          configPath: flags.configPath,
        });
      } catch (err: any) {
        process.stderr.write(`failed to start: ${err.message}\n`);
        process.exit(1);
      }
      // Keep the process alive; signal handlers exit cleanly.
      await new Promise(() => {});
      return;
    }
  }
}

main().catch(err => {
  process.stderr.write(`unexpected error: ${err?.message ?? err}\n`);
  process.exit(1);
});
