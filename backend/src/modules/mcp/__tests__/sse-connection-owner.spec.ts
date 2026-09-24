import { EventEmitter } from 'events';

import { SseTransport } from '../transports/sse.transport';
import { McpTransportController } from '../controllers/mcp-transport.controller';

/**
 * An SSE connection belongs to the user who opened it.
 *
 * POST /mcp/sse/:connectionId/message ran the JSON-RPC as
 * `connection.userId` and only compared the poster's organization to the
 * connection's. Another member of the same organization holding the id
 * (it is in the stream's `endpoint` frame, in proxy and access logs, in a
 * shared terminal) could call tools as the user who opened the stream --
 * including that user's private gateways and tools -- and read the result
 * in their own response. The streamable transport already binds its
 * sessions to the minting user; this is the same rule for SSE.
 */
describe('SSE message posting is bound to the connection owner', () => {
  function build() {
    const handleJsonRpc = jest.fn(async (msg: any, organizationId: string, userId?: string) => ({
      jsonrpc: '2.0',
      id: msg.id,
      result: { ranAs: { organizationId, userId } },
    }));
    const sessions = {
      createSession: jest.fn((organizationId: string, _t: string, userId?: string) => ({
        id: `session-${userId}`,
        organizationId,
        userId,
      })),
      removeSession: jest.fn(),
      on: jest.fn(),
    };
    const transport = new SseTransport({ handleJsonRpc } as any, sessions as any);
    const controller = new McpTransportController({} as any, transport, {} as any, {} as any);
    return { transport, controller, handleJsonRpc };
  }

  function stream(): any {
    const res: any = new EventEmitter();
    res.setHeader = jest.fn();
    res.write = jest.fn();
    res.end = jest.fn();
    res.destroyed = false;
    res.req = { originalUrl: '/mcp/sse' };
    return res;
  }

  const call = { jsonrpc: '2.0' as const, id: 7, method: 'tools/call', params: { name: 'x' } };
  const member = (id: string, org = 'org-1') => ({ user: { id, currentOrganizationId: org } });

  let transport: SseTransport;
  afterEach(async () => {
    await transport?.shutdown();
  });

  it('refuses another member of the same organization, without running anything', async () => {
    const built = build();
    transport = built.transport;
    const connectionId = await transport.handleSseConnection(stream(), 'org-1', 'alice');

    const res = await built.controller.sendSseMessage(connectionId, call as any, member('mallory'));

    expect(res.error).toEqual({ code: -32001, message: 'Connection not found' });
    expect(built.handleJsonRpc).not.toHaveBeenCalled();
  });

  it('refuses a caller from another organization', async () => {
    const built = build();
    transport = built.transport;
    const connectionId = await transport.handleSseConnection(stream(), 'org-1', 'alice');

    const res = await built.controller.sendSseMessage(connectionId, call as any, member('alice', 'org-2'));

    expect(res.error?.code).toBe(-32001);
    expect(built.handleJsonRpc).not.toHaveBeenCalled();
  });

  it('refuses when no caller is given at all, rather than trusting the connection', async () => {
    const built = build();
    transport = built.transport;
    const connectionId = await transport.handleSseConnection(stream(), 'org-1', 'alice');

    const res = await (transport as any).handleSseMessage(connectionId, call);

    expect(res.error?.code).toBe(-32001);
    expect(built.handleJsonRpc).not.toHaveBeenCalled();
  });

  it('runs the owner\'s own messages as the owner', async () => {
    const built = build();
    transport = built.transport;
    const connectionId = await transport.handleSseConnection(stream(), 'org-1', 'alice');

    const res = await built.controller.sendSseMessage(connectionId, call as any, member('alice'));

    expect(res.result).toEqual({ ranAs: { organizationId: 'org-1', userId: 'alice' } });
  });
});
