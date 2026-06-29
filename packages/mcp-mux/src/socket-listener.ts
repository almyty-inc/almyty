/**
 * SocketListener — the real Unix-socket implementation of the inbound side.
 * Each accepted connection becomes one `Session`: its stream is framed by a
 * LineReader (partial lines never reach the mux), `send` writes frame+newline,
 * and `close` destroys the socket. The listener registers each session with the
 * mux; the mux tears the session down on the socket's 'close' event.
 *
 * One process leak class to avoid here too: a socket accepted but never handed
 * to the mux would leak. We register synchronously on 'connection', before any
 * await, so every accepted fd has an owner.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { LineReader } from './line-reader.js';
import type { Session } from './types.js';
import type { McpStdioMux } from './mux.js';

class SocketSession extends EventEmitter implements Session {
  private readonly reader: LineReader;
  private closed = false;

  constructor(
    public readonly id: string,
    private readonly socket: Socket,
  ) {
    super();
    this.reader = new LineReader((line) => this.emit('frame', line));
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.reader.push(chunk));
    socket.once('close', () => this.markClosed());
    socket.on('error', () => this.markClosed());
  }

  send(frame: string): void {
    if (this.closed || !this.socket.writable) return;
    this.socket.write(frame + '\n');
  }

  close(): void {
    if (this.closed) return;
    this.socket.destroy();
    // 'close' will fire markClosed(); guard in case destroy is synchronous.
    this.markClosed();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

export interface SocketListenerOptions {
  /** Filesystem path for the Unix domain socket. */
  socketPath: string;
}

export class SocketListener {
  private readonly server: Server;
  private seq = 0;

  constructor(
    private readonly mux: McpStdioMux,
    private readonly opts: SocketListenerOptions,
  ) {
    this.server = createServer((socket) => this.onConnection(socket));
  }

  /** Register the connection with the mux SYNCHRONOUSLY — no await before this. */
  private onConnection(socket: Socket): void {
    const session = new SocketSession(`s${++this.seq}`, socket);
    this.mux.addSession(session); // mux wires 'frame'/'close' and owns teardown
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.socketPath, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
