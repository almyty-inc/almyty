import { ProcessManager, shellExec } from './process-manager.js';
import { enforceSpawnPolicy, enforceShellPolicy } from './policy.js';
import { detectRuntimeInfo, RUNNER_VERSION } from './runtime-info.js';
import { RequestPayload, ResponsePayload, WORKER_ERROR_CODES } from './protocol.js';
import {
  buildAgentSpawn,
  classifyStatus,
  detectCodingAgents,
  findByBinary,
  getCodingAgent,
  listCodingAgents,
  stripVtEscapes,
  type AgentSpawnInput,
} from './coding-agents/index.js';
import { realExec, type ProbeExec } from './binaries.js';
import { CodingSessionManager } from './coding-sessions.js';
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
  /** Coding-session registry (chat-to-runner bridge); wired by the daemon. */
  coding?: CodingSessionManager;
  /** Test injection for coding.list's binary probing. */
  probeExec?: ProbeExec;
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
      case 'agent.list': return ok(agentList());
      case 'agent.spawn': return ok(await agentSpawn(ctx, req));
      case 'agent.status': return ok(agentStatus(ctx, req));
      case 'coding.list': return ok(await codingList(ctx));
      case 'coding.start': return ok(await codingStart(ctx, req));
      case 'coding.input': return ok(codingInput(ctx, req));
      case 'coding.status': return ok(codingStatus(ctx, req));
      case 'coding.stop': return ok(codingStop(ctx, req));
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

// ── coding-agent surface ────────────────────────────────────────────

/**
 * Catalog of coding-agent platforms this runner knows how to drive. Static —
 * what's actually installed is in runner.info's runtime.codingAgents. The
 * catalog tells an orchestrator what it COULD ask for and the levers per CLI.
 */
function agentList(): unknown {
  return {
    platforms: listCodingAgents().map((s) => ({
      id: s.id,
      displayName: s.displayName,
      binary: s.binary,
      providerFamily: s.providerFamily,
      apiKeyEnvVars: s.apiKeyEnvVars,
      configDirEnvVar: s.configDirEnvVar,
      supportsMcp: s.supportsMcp,
      canManage: s.canManage,
      resume: s.session.kind,
    })),
  };
}

/**
 * Launch a coding-agent CLI as an unattended member. Builds the platform's
 * spawn spec (headless auth + isolated config home + auto-approve + resume),
 * then runs it through the SAME execution policy as process.spawn — the coding
 * agent gets no privilege the generic surface wouldn't.
 */
async function agentSpawn(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  const ws = requireWorkspace(req);
  const p = req.params as { platform?: string } & AgentSpawnInput;
  const spec = getCodingAgent(requireString(p.platform, 'platform'));
  if (!spec) {
    throw new RunnerError(`unknown coding-agent platform ${p.platform}`, RUNNER_ERROR_CODES.PATH_DENIED);
  }
  const opts = buildAgentSpawn(spec, {
    apiKey: p.apiKey,
    apiKeyEnvVar: p.apiKeyEnvVar,
    configDir: p.configDir,
    autoApprove: p.autoApprove,
    model: p.model,
    resumeSessionId: p.resumeSessionId,
    extraArgs: Array.isArray(p.extraArgs) ? p.extraArgs.map(String) : undefined,
    cwd: p.cwd,
  });
  // Same policy gate as process.spawn — isolation/deny/cwd/install all apply.
  opts.env = enforceSpawnPolicy(ctx.config, opts).env;
  const handle = await ctx.processes.spawn(ws, opts);
  return { processId: handle.processId, platform: spec.id, binary: spec.binary, args: opts.args };
}

/**
 * Non-destructively classify a spawned agent's pane: busy / idle /
 * awaiting_input / awaiting_auth / error. Resolves the platform from the
 * process's binary (or an explicit `platform` override), strips VT escapes
 * from the recent tail, and runs the per-CLI status table. Does NOT drain the
 * agent's own read() buffer.
 */
function agentStatus(ctx: HandlerContext, req: RequestPayload): unknown {
  const ws = requireWorkspace(req);
  const p = req.params as { processId?: string; platform?: string };
  const snap = ctx.processes.snapshot(ws, requireString(p.processId, 'processId'));
  const spec = p.platform ? getCodingAgent(p.platform) : findByBinary(snap.binary);
  if (!spec) {
    throw new RunnerError(
      `cannot resolve coding-agent platform for binary ${snap.binary}`,
      RUNNER_ERROR_CODES.PATH_DENIED,
    );
  }
  const screen = stripVtEscapes(snap.tail);
  const agentStatusValue =
    snap.status !== 'running' ? 'exited' : classifyStatus(spec.status, screen);
  return {
    platform: spec.id,
    processStatus: snap.status,
    status: agentStatusValue,
    idleMs: snap.idleMs,
  };
}

// ── coding-session surface (chat-to-runner bridge) ─────────────────
//
// Unlike agent.* (workspace-scoped unattended members), coding.* sessions
// are daemon-global interactive sessions driven from the chat REPL. The
// CodingSessionManager namespaces each one under a synthetic workspace and
// streams output upstream as coding.output/coding.exit event envelopes.

function requireCoding(ctx: HandlerContext): CodingSessionManager {
  if (!ctx.coding) {
    throw new RunnerError(
      'coding sessions are not available on this runner',
      RUNNER_ERROR_CODES.PATH_DENIED,
    );
  }
  return ctx.coding;
}

/** Coding CLIs actually installed on this machine (fresh probe). */
async function codingList(ctx: HandlerContext): Promise<unknown> {
  const agents = await detectCodingAgents(ctx.probeExec ?? realExec);
  return { agents };
}

/**
 * Start a coding session: resolve the platform spec, build the spawn spec
 * (auto-approve, task as final positional arg, pipe stdio), run it through
 * the SAME execution policy as process.spawn, then hand it to the session
 * registry which streams output back as events.
 */
async function codingStart(ctx: HandlerContext, req: RequestPayload): Promise<unknown> {
  const coding = requireCoding(ctx);
  const p = req.params as {
    agent?: string;
    task?: string;
    cwd?: string;
    model?: string;
    extraArgs?: string[];
  };
  const spec = getCodingAgent(requireString(p.agent, 'agent'));
  if (!spec) {
    throw new RunnerError(`unknown coding agent ${p.agent}`, RUNNER_ERROR_CODES.PATH_DENIED);
  }
  const input = {
    task: requireString(p.task, 'task'),
    cwd: typeof p.cwd === 'string' && p.cwd.length > 0 ? p.cwd : undefined,
    model: typeof p.model === 'string' ? p.model : undefined,
    extraArgs: Array.isArray(p.extraArgs) ? p.extraArgs.map(String) : undefined,
  };
  const opts = coding.buildStartOptions(spec, input);
  // Same policy gate as process.spawn — isolation/deny/cwd/install all apply.
  opts.env = enforceSpawnPolicy(ctx.config, opts).env;
  return coding.start(spec, input, opts);
}

/** Route a line of user input to the session's stdin. */
function codingInput(ctx: HandlerContext, req: RequestPayload): unknown {
  const coding = requireCoding(ctx);
  const p = req.params as { sessionId?: string; data?: string };
  coding.input(requireString(p.sessionId, 'sessionId'), requireString(p.data, 'data'));
  return {};
}

/** One session's status, or the full session list when sessionId is omitted. */
function codingStatus(ctx: HandlerContext, req: RequestPayload): unknown {
  const coding = requireCoding(ctx);
  const p = req.params as { sessionId?: string };
  if (typeof p.sessionId === 'string' && p.sessionId.length > 0) {
    return coding.status(p.sessionId);
  }
  return { sessions: coding.list() };
}

/** Stop a session (TERM; KILL with force). */
function codingStop(ctx: HandlerContext, req: RequestPayload): unknown {
  const coding = requireCoding(ctx);
  const p = req.params as { sessionId?: string; force?: boolean };
  return coding.stop(requireString(p.sessionId, 'sessionId'), p.force === true);
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
