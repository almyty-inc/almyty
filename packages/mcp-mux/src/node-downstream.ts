/**
 * NodeDownstream — the real child_process implementation of the `Downstream`
 * seam. Spawns one stdio MCP server, parses its stdout into newline-delimited
 * JSON frames (via LineReader, so partial lines never reach the mux), and
 * serializes writes to stdin with back-pressure-aware flushing.
 *
 * This is the ONLY file in the package that touches child_process; everything
 * else is driven through the `Downstream` interface so it stays unit-testable.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { LineReader } from './line-reader.js';
import type { Downstream, DownstreamFactory } from './types.js';

export interface NodeDownstreamSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Where to forward the child's stderr. Default: inherit to this process' stderr. */
  stderr?: 'inherit' | 'ignore' | ((chunk: Buffer) => void);
}

export class NodeDownstream extends EventEmitter implements Downstream {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader = new LineReader((line) => this.emit('line', line));
  private exited = false;

  constructor(spec: NodeDownstreamSpec) {
    super();
    const stderrMode = spec.stderr === undefined ? 'inherit' : spec.stderr;
    this.child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', typeof stderrMode === 'function' ? 'pipe' : stderrMode],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.on('data', (chunk: Buffer) => this.reader.push(chunk));
    if (typeof stderrMode === 'function' && this.child.stderr) {
      this.child.stderr.on('data', stderrMode);
    }
    this.child.on('error', (err) => this.emit('error', err));
    this.child.once('exit', (code, signal) => {
      this.exited = true;
      const tail = this.reader.flushRemainder();
      if (tail) this.emit('line', tail);
      this.emit('exit', { code, signal });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /**
   * Write one frame + newline. Resolves once the data is accepted (or flushed
   * past a full buffer). The mux awaits this to serialize framing, so a write
   * that can't complete must reject rather than silently drop.
   */
  write(frame: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child.stdin.writable) {
        reject(new Error('downstream stdin not writable'));
        return;
      }
      this.child.stdin.write(frame + '\n', (err) => (err ? reject(err) : resolve()));
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.exited) return;
    try {
      this.child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Factory the Supervisor uses to (re)spawn the child on demand. */
export class NodeDownstreamFactory implements DownstreamFactory {
  constructor(private readonly spec: NodeDownstreamSpec) {}
  async spawn(): Promise<Downstream> {
    return new NodeDownstream(this.spec);
  }
}
