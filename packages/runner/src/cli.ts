#!/usr/bin/env node
/**
 * almyty-runner CLI.
 *
 *   almyty-runner start [--name X] [--org ORG_ID] [--label k=v]... [--config path] [--url URL]
 *   almyty-runner status
 *   almyty-runner stop
 *
 * Auth: ALMYTY_TOKEN env or ~/.almyty/credentials.json (run
 * `almyty-auth login` first if neither is configured). The runner is
 * registered to whoever that login belongs to; the name is only a label.
 */

import { RunnerDaemon, readStatus, stopDaemon } from './daemon.js';
import { RUNNER_VERSION } from './runtime-info.js';
import { parseArgs } from './cli-args.js';

export { parseArgs, COMMANDS, type ParsedFlags } from './cli-args.js';

function printHelp(): void {
  process.stdout.write(`almyty-runner v${RUNNER_VERSION}

Usage:
  almyty-runner start [options]    Register and run the daemon
  almyty-runner status             Show local daemon status
  almyty-runner stop               Send SIGTERM to the local daemon

Options for start:
  --name <name>           Runner name (matches [a-zA-Z0-9_-]{1,64}); a label, unique in the org
  --org <org-id>          Organization to register in (needed if you belong to several)
  --label key=value       Add a descriptive label; repeat for multiple
  --config <path>         Path to a JSON config file (overrides global+project)
  --url <backend-url>     Override backend URL (e.g. https://api.almyty.com)

Other:
  -h, --help              Show this help
  -v, --version           Print the version

Exit codes:
  0  success
  1  the command ran and failed (no daemon running, start refused)
  2  usage error (unknown command, bad flags)

Auth:
  ALMYTY_TOKEN env or ~/.almyty/credentials.json (\`almyty-auth login\`).
  The runner belongs to the user that login is for. Nobody else can
  attach to it, whatever name they pick.
`);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv);
  if (flags.error) {
    process.stderr.write(`${flags.error}\n`);
    process.exit(2);
  }
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
          organizationId: flags.org,
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
