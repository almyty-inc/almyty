/**
 * Programmatic exports for the runner package.
 *
 * Most consumers run the CLI (`almyty-runner start`); programmatic
 * access exists so backend tests and the integration spec can drive
 * the runner without spawning a subprocess.
 */
export { RunnerDaemon, readStatus, stopDaemon, type DaemonStatus } from './daemon.js';
export {
  ProcessManager,
  shellExec,
  createDefaultAdapterFactory,
  type ProcessAdapter,
  type AdapterFactory,
} from './process-manager.js';
export {
  CodingSessionManager,
  type CodingEmitter,
  type CodingEventPayload,
  type CodingSessionRecord,
  type CodingStartInput,
} from './coding-sessions.js';
export { loadConfig, DEFAULTS, DEFAULT_BINARY_PROBE_LIST, GLOBAL_CONFIG_PATH, PROJECT_CONFIG_PATH } from './config.js';
export { detectRuntimeInfo, RUNNER_VERSION } from './runtime-info.js';
export { probe, probeAll, realExec, type ProbeExec } from './binaries.js';
export { dispatchHandler, type HandlerContext } from './handlers.js';
export {
  StreamableClient,
  envelope,
  type StreamableClientOptions,
} from './streamable-client.js';
export {
  WORKER_PROTOCOL_VERSION,
  WORKER_ERROR_CODES,
  isWorkerEnvelope,
  type WorkerEnvelope,
  type RequestPayload,
  type ResponsePayload,
  type HeartbeatPayload,
} from './protocol.js';
export {
  RunnerError,
  RUNNER_ERROR_CODES,
  type ResolvedConfig,
  type RunnerConfig,
  type RunnerInfo,
  type RunnerRuntimeInfo,
  type ProcessHandle,
  type ProcessSignal,
  type SpawnOptions,
  type ReadResult,
  type WaitForIdleOptions,
  type WaitForIdleResult,
  type WaitResult,
  type ShellExecResult,
} from './types.js';
