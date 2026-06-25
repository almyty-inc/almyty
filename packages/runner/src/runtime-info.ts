import { hostname, arch as osArch, platform as osPlatform, cpus, totalmem } from 'os';

import { probeAll, ProbeExec, realExec } from './binaries.js';
import { detectCodingAgents } from './coding-agents/index.js';
import { RunnerRuntimeInfo } from './types.js';

/**
 * Snapshot the runner's runtime characteristics.
 *
 * Every field here is detected, never settable from config. This is
 * the read-only twin of the user's RunnerConfig: routing matches on
 * either, but only the user can change RunnerConfig values, and
 * only the runtime can produce these values.
 *
 * RUNNER_VERSION should track packages/runner/package.json. Bumping
 * the package version without bumping this constant is a benign
 * mismatch; the constant is what the backend records in the runner
 * row's runtimeInfo.runnerVersion.
 */
export const RUNNER_VERSION = '0.1.0';

export interface DetectInputs {
  /** Override binary list. Defaults to the resolved config's list. */
  binaries: string[];
  /** Test injection point: stub child_process.spawn. */
  exec?: ProbeExec;
}

export async function detectRuntimeInfo(inputs: DetectInputs): Promise<RunnerRuntimeInfo> {
  const exec = inputs.exec ?? realExec;
  const [binaries, codingAgents] = await Promise.all([
    probeAll(inputs.binaries, exec),
    detectCodingAgents(exec),
  ]);
  return {
    os: osPlatform(),
    arch: osArch(),
    hostname: hostname(),
    cpuCount: cpus().length,
    memoryMb: Math.round(totalmem() / (1024 * 1024)),
    runnerVersion: RUNNER_VERSION,
    binaries,
    codingAgents,
  };
}
