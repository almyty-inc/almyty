/**
 * Public types for the runner package. Mirrored against the backend
 * Runner / Workspace shapes; we keep them duplicated rather than
 * importing from the backend so the runner can be installed and
 * versioned without dragging the backend's dep graph in.
 */

export type RunnerIsolationTier = 'container' | 'host';

export interface RunnerRuntimeInfo {
  os: string;
  arch: string;
  hostname: string;
  cpuCount: number;
  memoryMb: number;
  runnerVersion: string;
  binaries: Record<string, string | null>;
}

export interface RunnerConfig {
  defaultIsolation: RunnerIsolationTier;
  maxConcurrent: number;
  allowedCwdRoots: string[];
  denyPatterns: string[];
  networkBlocked: boolean;
  installBlocked: boolean;
}

/**
 * Resolved runner-side configuration. Combines the user-set fields
 * (name, labels, RunnerConfig) with the binary probe list and the
 * backend URL. Result of merging defaults < global < project < env <
 * flags.
 */
export interface ResolvedConfig {
  name: string;
  labels: Record<string, string>;
  config: RunnerConfig;
  binaryProbeList: string[];
  backendUrl: string;
}

export interface RunnerInfo {
  name: string;
  labels: Record<string, string>;
  runtime: RunnerRuntimeInfo;
  runnerVersion: string;
  binaries: Record<string, string | null>;
  capacity: { maxConcurrent: number; inUse: number };
}

// Process surface ────────────────────────────────────────────────────

export type ProcessStatus = 'running' | 'exited' | 'killed';

export interface ProcessHandle {
  processId: string;
  binary: string;
  startedAt: Date;
  status: ProcessStatus;
  /** Workspace this process is scoped to. Cross-workspace access is denied. */
  workspaceId: string;
}

export interface SpawnOptions {
  binary: string;
  args: string[];
  env?: Record<string, string>;
  /** Default true; set false for raw-pipe mode without a TTY. */
  pty?: boolean;
  cwd?: string;
}

export interface ReadResult {
  data: string;
  /** True when more output is buffered beyond what we returned now. */
  moreAvailable: boolean;
}

export interface WaitForIdleOptions {
  /** Return when the process produces no output for this long (ms). */
  idleMs: number;
  /** Hard cap on how long to wait regardless of activity (ms). */
  maxWaitMs: number;
}

export interface WaitForIdleResult {
  data: string;
  /** True when we returned because of idle, false when max-wait fired. */
  idle: boolean;
}

export interface WaitResult {
  exitCode: number | null;
  signal: string | null;
}

export type ProcessSignal = 'TERM' | 'INT' | 'KILL';

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

// Errors ─────────────────────────────────────────────────────────────

export class RunnerError extends Error {
  constructor(message: string, public readonly code: string, public readonly data?: unknown) {
    super(message);
    this.name = 'RunnerError';
  }
}

export const RUNNER_ERROR_CODES = {
  PROCESS_NOT_FOUND: 'process_not_found',
  PROCESS_CROSS_WORKSPACE: 'process_cross_workspace',
  CAPACITY_EXCEEDED: 'capacity_exceeded',
  PATH_DENIED: 'path_denied',
  COMMAND_DENIED: 'command_denied',
  PROCESS_ALREADY_EXITED: 'process_already_exited',
  TIMEOUT: 'timeout',
} as const;
