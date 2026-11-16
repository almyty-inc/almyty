/**
 * Stdio transport that answers what it was asked before it goes.
 *
 * The SDK's StdioServerTransport closes the moment stdin reaches EOF. A
 * client that writes its requests and then closes its end of the pipe
 * (`printf '...' | npx @almyty/mcp-server`, or a test harness) got no
 * replies at all: the first message waits for discovery inside the
 * serveStdio factory, EOF arrives meanwhile, the transport closes and the
 * queued requests are dropped. The process exited 0 with an empty stdout.
 *
 * This one reads the same newline-delimited JSON-RPC, but on EOF it stays
 * open until every request already received has been answered (or
 * `drainTimeoutMs` has passed), and only then closes. A
 * `subscriptions/listen` request is a stream that lasts as long as the
 * connection, so it is not waited for.
 */
import type { Readable, Writable } from 'node:stream';
import {
  ReadBuffer,
  serializeMessage,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/server';

type RequestId = string | number;

export interface DrainingStdioOptions {
  /** How long EOF waits for the answers still owed. Default 120 s. */
  drainTimeoutMs?: number;
}

export class DrainingStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];

  private readonly buffer = new ReadBuffer();
  private readonly owed = new Set<RequestId>();
  private started = false;
  private closed = false;
  private inputEnded = false;
  private drainTimer?: NodeJS.Timeout;
  private readonly drainTimeoutMs: number;

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
    options: DrainingStdioOptions = {},
  ) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? 120_000;
  }

  /** Requests received and not yet answered (for tests and diagnostics). */
  get pending(): number {
    return this.owed.size;
  }

  private readonly onData = (chunk: Buffer) => {
    try {
      this.buffer.append(chunk);
    } catch (error) {
      this.onerror?.(error as Error);
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch (error) {
        this.onerror?.(error as Error);
        continue;
      }
      if (message === null) break;
      if (isJSONRPCRequest(message) && message.method !== 'subscriptions/listen') this.owed.add(message.id);
      this.onmessage?.(message);
    }
  };

  private readonly onInputEnd = () => {
    if (this.inputEnded) return;
    this.inputEnded = true;
    // Every byte read has been parsed and handed on synchronously in
    // onData, so what is owed now is all that will ever be owed.
    if (this.owed.size === 0) {
      void this.close();
      return;
    }
    this.drainTimer = setTimeout(() => {
      this.onerror?.(new Error(`stdin closed with ${this.owed.size} request(s) unanswered after ${this.drainTimeoutMs} ms`));
      void this.close();
    }, this.drainTimeoutMs);
    this.drainTimer.unref?.();
  };

  private readonly onStdinError = (error: Error) => this.onerror?.(error);

  private readonly onStdoutError = (error: Error) => {
    if (this.closed) return;
    this.onerror?.(error);
    void this.close();
  };

  async start(): Promise<void> {
    if (this.started) throw new Error('DrainingStdioTransport already started');
    this.started = true;
    this.stdin.on('data', this.onData);
    this.stdin.on('error', this.onStdinError);
    this.stdin.on('end', this.onInputEnd);
    this.stdin.on('close', this.onInputEnd);
    this.stdout.on('error', this.onStdoutError);
    if (this.stdin.readableEnded || this.stdin.destroyed) setImmediate(this.onInputEnd);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('DrainingStdioTransport is closed');
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.stdout.once('error', onError);
      const flushed = this.stdout.write(serializeMessage(message), (error) => {
        this.stdout.off('error', onError);
        if (error) reject(error);
        else resolve();
      });
      // A full pipe buffer still delivers the callback once drained.
      void flushed;
    });
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      if (message.id !== undefined && message.id !== null) this.owed.delete(message.id as RequestId);
      if (this.inputEnded && this.owed.size === 0) void this.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.stdin.off('data', this.onData);
    this.stdin.off('error', this.onStdinError);
    this.stdin.off('end', this.onInputEnd);
    this.stdin.off('close', this.onInputEnd);
    // Late write failures (EPIPE after the client went) are not news.
    this.stdout.off('error', this.onStdoutError);
    this.stdout.on('error', () => {});
    if (this.stdin.listenerCount('data') === 0) this.stdin.pause();
    this.buffer.clear();
    this.onclose?.();
  }
}
