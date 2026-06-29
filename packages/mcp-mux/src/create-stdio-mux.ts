/**
 * createStdioMux — convenience wiring for the common case: serve one stdio MCP
 * child to many clients over a Unix socket. Builds the McpStdioMux, a
 * NodeDownstreamFactory + Supervisor (which owns spawn/respawn), and a
 * SocketListener, then starts both.
 *
 * Returns a handle whose `close()` tears everything down in dependency order:
 * stop accepting connections, stop the supervisor (reap child + release log),
 * then close the mux. Southbound only — this never touches northbound serving.
 */
import { McpStdioMux } from './mux.js';
import { Supervisor, type SupervisorOptions } from './supervisor.js';
import { NodeDownstreamFactory, type NodeDownstreamSpec } from './node-downstream.js';
import { SocketListener } from './socket-listener.js';

export interface StdioMuxConfig {
  socketPath: string;
  downstream: NodeDownstreamSpec;
  supervisor?: SupervisorOptions;
}

export interface StdioMuxHandle {
  readonly mux: McpStdioMux;
  readonly supervisor: Supervisor;
  close(): Promise<void>;
}

export async function createStdioMux(config: StdioMuxConfig): Promise<StdioMuxHandle> {
  const mux = new McpStdioMux(config.supervisor);
  const factory = new NodeDownstreamFactory(config.downstream);
  const supervisor = new Supervisor(factory, mux, config.supervisor);
  const listener = new SocketListener(mux, { socketPath: config.socketPath });

  await supervisor.start(); // spawn the child first so early clients have a target
  try {
    await listener.listen();
  } catch (e) {
    // Listener failed to bind — don't leak the running child.
    await supervisor.stop();
    mux.close();
    throw e;
  }

  return {
    mux,
    supervisor,
    async close() {
      await listener.close();
      await supervisor.stop();
      mux.close();
    },
  };
}
