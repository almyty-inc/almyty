import { randomUUID } from 'crypto';
import { homedir } from 'os';

import { ProcessManager } from './process-manager.js';
import {
  buildAgentSpawn,
  stripVtEscapes,
  type CodingAgentSpec,
} from './coding-agents/index.js';
import { RunnerError, RUNNER_ERROR_CODES, type SpawnOptions } from './types.js';

/**
 * Daemon-side registry of interactive coding sessions — the runner half of
 * the chat-to-runner coding bridge.
 *
 * A coding session is one spawned coding CLI (claude, codex, gemini, ...)
 * driven line-based over stdio (pipe mode, NOT a PTY — full terminal
 * emulation is deliberately out of scope for v1). Output chunks are
 * ANSI-stripped and pushed upstream as `coding.output` event envelopes via
 * the emitter the daemon wires in (the same channel heartbeats ride); exit
 * is pushed as `coding.exit`.
 *
 * Sessions are namespaced under a synthetic workspace (`coding:<sessionId>`)
 * so they reuse the ProcessManager's bookkeeping, capacity accounting, and
 * cross-workspace isolation without inventing a parallel process table.
 */

export interface CodingStartInput {
  /** The task prompt handed to the CLI as its final positional argument. */
  task: string;
  /** Working directory; defaults to the daemon user's home. */
  cwd?: string;
  /** Model pin, where the CLI supports a plain --model flag. */
  model?: string;
  /** Extra argv appended before the task. */
  extraArgs?: string[];
}

export interface CodingSessionRecord {
  sessionId: string;
  /** Coding-agent platform id (claude, codex, ...). */
  agent: string;
  binary: string;
  processId: string;
  workspaceId: string;
  cwd: string;
  task: string;
  startedAt: string;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
}

export type CodingEventPayload =
  | { kind: 'coding.output'; sessionId: string; agent: string; data: string; seq: number }
  | {
      kind: 'coding.exit';
      sessionId: string;
      agent: string;
      exitCode: number | null;
      signal: string | null;
    };

export type CodingEmitter = (payload: CodingEventPayload) => void;

interface Session {
  record: CodingSessionRecord;
  seq: number;
  unsubscribe: () => void;
}

export class CodingSessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly processes: ProcessManager,
    private readonly emit: CodingEmitter,
  ) {}

  /**
   * Build the SpawnOptions for a session WITHOUT starting it, so the caller
   * (handlers.ts) can run the result through the execution policy first —
   * the same gate process.spawn and agent.spawn go through.
   */
  buildStartOptions(spec: CodingAgentSpec, input: CodingStartInput): SpawnOptions {
    const opts = buildAgentSpawn(spec, {
      autoApprove: true,
      model: input.model,
      cwd: input.cwd ?? homedir(),
      extraArgs: [...(input.extraArgs ?? []), input.task],
    });
    // Line-based stdio for v1: no PTY, stdout/stderr piped and merged.
    opts.pty = false;
    return opts;
  }

  /** Spawn the CLI and start streaming its output as coding.* events. */
  async start(
    spec: CodingAgentSpec,
    input: CodingStartInput,
    opts: SpawnOptions,
  ): Promise<CodingSessionRecord> {
    const sessionId = `cs_${randomUUID()}`;
    const workspaceId = `coding:${sessionId}`;
    const handle = await this.processes.spawn(workspaceId, opts);

    const record: CodingSessionRecord = {
      sessionId,
      agent: spec.id,
      binary: opts.binary,
      processId: handle.processId,
      workspaceId,
      cwd: opts.cwd ?? homedir(),
      task: input.task,
      startedAt: new Date().toISOString(),
      status: 'running',
      exitCode: null,
    };

    const session: Session = { record, seq: 0, unsubscribe: () => {} };
    session.unsubscribe = this.processes.observe(workspaceId, handle.processId, {
      onData: (chunk) => {
        // Strip ANSI/VT sequences so the chat transcript gets plain text.
        // Escape sequences split across chunk boundaries can leak fragments;
        // acceptable for v1 line-based output.
        const clean = stripVtEscapes(chunk);
        if (!clean) return;
        session.seq += 1;
        this.emit({
          kind: 'coding.output',
          sessionId,
          agent: spec.id,
          data: clean,
          seq: session.seq,
        });
      },
      onExit: (info) => {
        record.status = info.signal ? 'killed' : 'exited';
        record.exitCode = info.exitCode;
        session.unsubscribe();
        this.emit({
          kind: 'coding.exit',
          sessionId,
          agent: spec.id,
          exitCode: info.exitCode,
          signal: info.signal,
        });
      },
    });

    this.sessions.set(sessionId, session);
    return record;
  }

  /** Write a line of input to the session's stdin. */
  input(sessionId: string, data: string): void {
    const session = this.getOrThrow(sessionId);
    if (session.record.status !== 'running') {
      throw new RunnerError(
        `coding session ${sessionId} has already exited`,
        RUNNER_ERROR_CODES.PROCESS_ALREADY_EXITED,
      );
    }
    const line = data.endsWith('\n') ? data : `${data}\n`;
    this.processes.write(session.record.workspaceId, session.record.processId, line);
  }

  /** Snapshot one session (throws if unknown). */
  status(sessionId: string): CodingSessionRecord & { idleMs: number | null } {
    const session = this.getOrThrow(sessionId);
    let idleMs: number | null = null;
    try {
      idleMs = this.processes.snapshot(
        session.record.workspaceId,
        session.record.processId,
      ).idleMs;
    } catch {
      // Process already forgotten; the record still answers.
    }
    return { ...session.record, idleMs };
  }

  /** All sessions, newest last. */
  list(): CodingSessionRecord[] {
    return [...this.sessions.values()].map((s) => ({ ...s.record }));
  }

  /** Stop a session (TERM by default, KILL when force). Idempotent. */
  stop(sessionId: string, force = false): CodingSessionRecord {
    const session = this.getOrThrow(sessionId);
    if (session.record.status === 'running') {
      this.processes.signal(
        session.record.workspaceId,
        session.record.processId,
        force ? 'KILL' : 'TERM',
      );
    }
    return { ...session.record };
  }

  private getOrThrow(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RunnerError(
        `unknown coding session ${sessionId}`,
        RUNNER_ERROR_CODES.PROCESS_NOT_FOUND,
      );
    }
    return session;
  }
}
