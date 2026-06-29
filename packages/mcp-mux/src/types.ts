/**
 * Wire + seam types for the southbound stdio-MCP multiplexer.
 *
 * The `Downstream` and `Session` interfaces are the test seams (mirroring the
 * runner's AdapterFactory idiom): the multiplexer never spawns a process or
 * opens a socket itself — it's handed these, so tests inject in-process fakes.
 */
import type { EventEmitter } from 'node:events';

/** A JSON-RPC id per the spec: string | number | null (null only on errors). */
export type JsonRpcId = string | number | null;

/** Minimal JSON-RPC frame. We only care about `id`; everything else is opaque. */
export interface JsonRpcFrame {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  [k: string]: unknown;
}

/** One proxy-id -> origin reverse-map entry. */
export interface IdMapping {
  sessionId: string;
  originalId: JsonRpcId;
  /** Epoch ms the request was forwarded — drives TTL eviction. */
  sentAt: number;
}

/**
 * One downstream MCP child as seen by the multiplexer. Emits exactly one
 * `'line'` per complete newline-delimited JSON frame from the child's stdout
 * (partial-line buffering is the implementation's job, never the consumer's),
 * and `'exit'` once when the child is gone.
 *
 * `write` resolves only after the frame (including its trailing newline) is
 * flushed past back-pressure, so the caller can serialize frames by awaiting.
 */
export interface Downstream extends EventEmitter {
  readonly pid: number | undefined;
  /** Write one already-serialized JSON frame (no trailing newline; we add it). */
  write(frame: string): Promise<void>;
  /** Best-effort terminate. */
  kill(signal?: NodeJS.Signals): void;
  // events: 'line' (frame: string), 'exit' (info: { code, signal }), 'error' (err)
}

export interface DownstreamExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Factory the supervisor uses to (re)spawn the downstream. */
export interface DownstreamFactory {
  spawn(): Promise<Downstream>;
}

/**
 * One client connection == one session. The multiplexer reads `'frame'`
 * events (incoming client frames) and calls `send` to push responses back.
 */
export interface Session extends EventEmitter {
  readonly id: string;
  /** Push one serialized JSON frame to the client (newline added by impl). */
  send(frame: string): void;
  close(): void;
  // events: 'frame' (frame: string), 'close'
}

export interface MuxOptions {
  /** Evict id-map entries older than this (ms) and error their sessions. Default 300_000. */
  requestTtlMs?: number;
  /** Sweep cadence (ms). Default 30_000. */
  sweepIntervalMs?: number;
  /** Non-fatal logger. Defaults to stderr. */
  warn?: (msg: string) => void;
}

/** JSON-RPC error codes we synthesize. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  INTERNAL: -32603,
  DOWNSTREAM_TIMEOUT: -32010,
  DOWNSTREAM_GONE: -32011,
} as const;
