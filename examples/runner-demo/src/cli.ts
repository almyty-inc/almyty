#!/usr/bin/env node
/**
 * `npm run demo` entrypoint. Wires the live runner end of the
 * orchestrator: detects installed CLIs locally, copies the sample-app
 * fixture to a temp dir, runs the demo, prints the transcript, then
 * cleans up.
 *
 * No backend connection in this entry: detecting CLIs and running
 * subagents directly on the local machine is enough to demo the
 * cross-vendor wedge end-to-end. The version of the demo that
 * dispatches over a real RunnerDaemon connection is a follow-up
 * (cluster 2.5: routing); the orchestrator here is reused there
 * by passing in a RunnerDaemon-backed `subagent` function instead
 * of the local-spawn one below.
 */

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

import {
  copyFixtureToTempDir,
  InstallMessage,
  runDemo,
  type Subagent,
} from './demo.js';
import { detectInstalledClis } from './detect.js';
import { spawnSubagent } from './spawn-subagent.js';

async function main(): Promise<number> {
  const cwd = copyFixtureToTempDir();
  process.stdout.write(`# fixture copied to ${cwd}\n`);
  let exitCode = 0;
  try {
    const available = await detectInstalledClis();
    const subagent: Subagent = req => spawnSubagent(req);

    await runDemo({
      workspace: {
        cwd,
        release: async () => {
          // Local-only demo has nothing to release on the runner side;
          // we just clean the temp dir below.
        },
      },
      availableClis: available,
      subagent,
    });
  } catch (err: any) {
    if (err instanceof InstallMessage) {
      process.stdout.write(err.message + '\n');
      // Spec: "If no agent CLI is installed, print a clear setup
      // message with install commands and exit 0."
      exitCode = 0;
    } else {
      process.stderr.write(`demo failed: ${err.message}\n`);
      exitCode = 1;
    }
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* */ }
  }
  return exitCode;
}

main().then(code => process.exit(code), err => {
  process.stderr.write(`unexpected error: ${err?.message ?? err}\n`);
  process.exit(1);
});
