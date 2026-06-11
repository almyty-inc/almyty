import { ProcessManager, shellExec } from './process-manager.js';
import { enforceSpawnPolicy, enforceShellPolicy } from './policy.js';
import { detectRuntimeInfo, RUNNER_VERSION } from './runtime-info.js';
import { RequestPayload, ResponsePayload, WORKER_ERROR_CODES } from './protocol.js';
import {
  ProcessSignal,
  RUNNER_ERROR_CODES,
  RunnerError,
  RunnerConfig,
  SpawnOptions,
} from './types.js';

/**
 * Runner-side method dispatch. The protocol surface is the public
 * v1.0 contract documented in the runner spec; method names are
 * dotted strings ("process.spawn", "shell.exec", "runner.info").
 *
 * Every handler:
 *   - Pulls workspaceId out of the request payload (required for
 *     process.* and shell.*; optional for runner.info).
 *   - Validates params just enough to surface a typed error
 *     (RunnerError with a code) rather than crashing.
 *   - Returns a ResponsePayload with ok=true|false; the daemon wraps
 *     it in a `response` envelope and posts it back over the
 *     Streamable HTTP transport.
 *
 * Error mapping: unhandled exceptions become INTERNAL responses; any
 * RunnerError surfaces with its own code intact so the agent can
 * reason about retryability.
 */
export interface HandlerContext {
  processes: ProcessManager;
  runnerName: string;
  labels: Record<string, string>;
  maxConcurrent: number;
  /** Runner execution policy (isolation, denyPatterns, cwd roots, …). */
  config: RunnerConfig;
  /** Test injection point for runner.info; returns the cached probe map. */
  cachedRuntimeInfo?: Awaited<ReturnType<typeof detectRuntimeInfo>>;
}

export async function dispatchHandler(ctx: HandlerContext, req: RequestPayload): Promise<ResponsePayload> {
  try {
    switch (req.method) {
      case 'process.spawn': return ok(await spawn(ctx, req));
      case 'process.write': return ok(await write(ctx, req));
      case 'process.read': return ok(await read(ctx, req));
      case 'process.wait_for_idle': return ok(await waitForIdle(ctx, req));
      case 'process.signal': return ok(await signal(ctx, req));
      case 'process.close_input': return ok(await closeInput(ctx, req));
      case 'process.list': return ok(await list(ctx, req));
      case 'process.wait': return ok(await waitH(ctx, req));
      case 'shell.exec': return ok(await shell(ctx, req));
      case 'runner.info': return ok(await info(ctx));
      default:
        return err(WORKER_ERROR_CODES.MALFORMED_ENVELOPE, `unknown method ${req.method}`);
    }
  } catch (e: any) {
    if (e instanceof RunnerError) {
      return err(WORKER_ERROR_CODES.INTERNAL, e.message, { code: e.code, data: e.data });
    }
    return err(WORKER_ERROR_CODES.INTERNAL, e?.message ?? String(e));
  }
}

// ── handlers ────────────────────────────────────────────────────────

async function spawn(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  const ws = requireWorkspace(req);
  const p = req.params as Partial<SpawnOptions>;
  if (typeof p.binary !== 'string' || p.binary.length === 0) {
    throw new RunnerError('binary is required', RUNNER_ERROR_CODES.PATH_DENIED);
  }
  const args = Array.isArray(p.args) ? p.args.map(String) : [];
  const env = isStringMap(p.env) ? p.env : undefined;
  const opts: SpawnOptions = {
    binary: p.binary,
    args,
    env,
    pty: p.pty !== false,
    cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
  };
  // Enforce the runner execution policy (isolation/deny/cwd/install) and
  // use the sanitized env — refuses, rather than silently running, anything
  // the config forbids.
  opts.env = enforceSpawnPolicy(ctx.config, opts).env;
  const handle = await ctx.processes.spawn(ws, opts);
  return { processId: handle.processId };
}

async function write(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  const ws = requireWorkspace(req);
  const p = req.params as { processId?: string; data?: string };
  ctx.processes.write(ws, requireString(p.processId, 'processId'), requireString(p.data, 'data'));
  return {};
}

async function read(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  const ws = requireWorkspace(req);
  const p = req.params as { processId?: string };
  return ctx.processes.read(ws, requireString(p.processId, 'processId'));
}

async function waitForIdle(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  const ws = requireWorkspace(req);
  const p = req.params as { processId?: string; idleMs?: number; maxWaitMs?: number };
  const idleMs = typeof p.idleMs === 'number' ? p.idleMs : 250;
  const maxWaitMs = typeof p.maxWaitMs === 'number' ? p.maxWaitMs : 30_000;
  return ctx.processes.waitForIdle(ws, requireString(p.processId, 'processId'), { idleMs, maxWaitMs });
}

async function signal(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  const ws = requireWorkspace(req);
  const p = req.params as { processId?: string; signal?: ProcessSignal };
  const sig = p.signal ?? 'TERM';
  if (sig !== 'TERM' && sig !== 'INT' && sig !== 'KILL') {
    throw new RunnerError(`unsupported signal ${sig}`, RUNNER_ERROR_CODES.PATH_DENIED);
  }
  ctx.processes.signal(ws, requireString(p.processId, 'processId'), sig);
  return {};
}

async function closeInput(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  const ws = requireWorkspace(req);
  const p = req.params as { processId?: string };
  ctx.processes.closeInput(ws, requireString(p.processId, 'processId'));
  return {};
}

async function list(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  const ws = req.workspaceId; // optional: list all when undefined
  return { processes: ctx.processes.list(ws) };
}

async function waitH(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  const ws = requireWorkspace(req);
  const p = req.params as { processId?: string; timeoutMs?: number };
  return ctx.processes.wait(ws, requireString(p.processId, 'processId'), p.timeoutMs);
}

async function shell(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  // shell.exec is workspace-scoped for audit but doesn't depend on
  // the process manager's bookkeeping; one-shot execution returns
  // stdout+stderr+exit and forgets.
  requireWorkspace(req);
  const p = req.params as { cmd?: string; env?: Record<string, string>; timeoutMs?: number };
  const cmd = requireString(p.cmd, 'cmd');
  // Enforce the same execution policy as process.spawn — isolation
  // fail-closed, denyPatterns, installBlocked — and run with the
  // sanitized env. Without this, shell.exec was a hole straight past
  // every protection spawn honours.
  const { env } = enforceShellPolicy(ctx.config, cmd, p.env);
  return shellExec(cmd, env, p.timeoutMs);
}

async function info(ctx: HandlerContext): Promise<unknown> {
  // We re-detect on every call; binaries can be installed/removed at
  // runtime and the user expects the snapshot to be fresh. Cheap when
  // probeAll runs in parallel.
  const runtime = ctx.cachedRuntimeInfo
    ?? await detectRuntimeInfo({ binaries: [] });
  return {
    name: ctx.runnerName,
    labels: ctx.labels,
    runtime,
    runnerVersion: RUNNER_VERSION,
    binaries: runtime.binaries,
    capacity: { maxConcurrent: ctx.maxConcurrent, inUse: ctx.processes.inUse() },
  };
}

// ── helpers ─────────────────────────────────────────────────────────

function requireWorkspace(req: RequestPayload): string {
  if (!req.workspaceId) {
    throw new RunnerError('workspaceId is required', RUNNER_ERROR_CODES.PATH_DENIED);
  }
  return req.workspaceId;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new RunnerError(`${name} is required`, RUNNER_ERROR_CODES.PATH_DENIED);
  }
  return v;
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object') return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
  }
  return true;
}

function ok(result: unknown): ResponsePayload {
  return { ok: true, result };
}

function err(code: number, message: string, data?: unknown): ResponsePayload {
  return { ok: false, error: { code, message, data } };
}
