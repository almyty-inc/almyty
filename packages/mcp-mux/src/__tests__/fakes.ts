import { EventEmitter } from 'node:events';
import type { Downstream, DownstreamFactory, Session } from '../types.js';

/** In-process downstream that speaks newline-JSON. Records writes; you drive responses. */
export class FakeDownstream extends EventEmitter implements Downstream {
  pid: number | undefined = 1234;
  written: string[] = [];
  killed: number = 0;
  /** Optional artificial write latency to exercise the framing queue. */
  writeDelayMs = 0;
  private exited = false;

  async write(frame: string): Promise<void> {
    if (this.exited) throw new Error('EPIPE');
    if (this.writeDelayMs > 0) await new Promise((r) => setTimeout(r, this.writeDelayMs));
    this.written.push(frame);
  }
  kill(): void {
    this.killed++;
    if (!this.exited) {
      this.exited = true;
      this.emit('exit', { code: null, signal: 'SIGKILL' });
    }
  }
  /** Emit a response/notification line as the child would. */
  emitLine(obj: unknown): void {
    this.emit('line', typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
  /** Simulate the child dying on its own. */
  die(): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', { code: 1, signal: null });
  }
  /** The proxy id assigned to the Nth write (parses the written frame). */
  idOfWrite(i: number): unknown {
    return JSON.parse(this.written[i]).id;
  }
}

export class FakeSession extends EventEmitter implements Session {
  sent: string[] = [];
  closed = false;
  constructor(public readonly id: string) {
    super();
  }
  send(frame: string): void {
    this.sent.push(frame);
  }
  close(): void {
    this.closed = true;
    this.emit('close');
  }
  /** Push an incoming client frame. */
  client(obj: unknown): void {
    this.emit('frame', typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
  /** Parsed last response the client received. */
  last(): any {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

/** Factory whose spawn behavior you control (for supervisor tests). */
export class FakeFactory implements DownstreamFactory {
  spawns: FakeDownstream[] = [];
  failNext = false;
  async spawn(): Promise<Downstream> {
    if (this.failNext) throw new Error('spawn failed');
    const ds = new FakeDownstream();
    this.spawns.push(ds);
    return ds;
  }
}
