import {
  McpSurface,
  TASKS_EXTENSION,
  declaresElicitation,
  declaresTasks,
  handleSingleMessage,
} from '../mcp-protocol-core';
import { mcpHttpStatusOf, resolveMcpRequestVersion } from '../mcp-http-binding';

/**
 * The Tasks extension and multi round-trip results in the protocol core
 * (2026-07-28): who gets a task handle or an input request, the -32021 for
 * a client that did not declare the extension, and the Mcp-Name routing
 * header of the task methods.
 */
const V = '2026-07-28';
const withTasks = { extensions: { [TASKS_EXTENSION]: {} } };
const ctx = (clientCapabilities: Record<string, unknown> = {}) => ({ version: V as any, era: 'modern' as const, clientCapabilities });

function surface(over: Partial<McpSurface> = {}): McpSurface {
  return {
    serverInfo: () => ({ name: 'almyty', version: '1.0.0' }),
    capabilities: () => ({ tools: { listChanged: false } }),
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...over,
  };
}

const tasks = {
  get: jest.fn(async ({ taskId }: { taskId: string }) => ({ taskId, status: 'working', createdAt: 'a', lastUpdatedAt: 'b', ttlMs: null })),
  update: jest.fn(async () => ({})),
  cancel: jest.fn(async () => ({})),
};

const call = (method: string, params: any, s: McpSurface, c = ctx(withTasks)) =>
  handleSingleMessage({ jsonrpc: '2.0', id: 1, method, params }, s, c) as Promise<any>;

describe('Tasks extension in the core', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads what the request declared', () => {
    expect(declaresTasks(ctx(withTasks))).toBe(true);
    expect(declaresTasks(ctx({ extensions: { other: {} } }))).toBe(false);
    expect(declaresTasks({ version: '2025-11-25', era: 'legacy', clientCapabilities: withTasks })).toBe(false);
    expect(declaresElicitation(ctx({ elicitation: {} }))).toBe(true);
    expect(declaresElicitation(ctx({ elicitation: { form: {} } }))).toBe(true);
    expect(declaresElicitation(ctx({ elicitation: { url: {} } }))).toBe(false);
    expect(declaresElicitation(ctx())).toBe(false);
  });

  it('advertises the extension on discover only for a surface that serves tasks', async () => {
    const withIt = await call('server/discover', {}, surface({ tasks }));
    expect(withIt.result.capabilities.extensions).toEqual({ [TASKS_EXTENSION]: {} });
    const without = await call('server/discover', {}, surface());
    expect(without.result.capabilities.extensions).toBeUndefined();
  });

  it('answers tasks/get with the task, resultType complete', async () => {
    const res = await call('tasks/get', { taskId: 't-1' }, surface({ tasks }));
    expect(res.result).toMatchObject({ resultType: 'complete', taskId: 't-1', status: 'working' });
    expect(tasks.get).toHaveBeenCalledWith({ taskId: 't-1' }, expect.objectContaining({ era: 'modern' }));
  });

  it('refuses the task methods with -32021 when the request did not declare the extension', async () => {
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      const res = await call(method, { taskId: 't-1', inputResponses: {} }, surface({ tasks }), ctx());
      expect(res.error).toEqual({
        code: -32021,
        message: 'Missing required client capability',
        data: { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
      });
      expect(mcpHttpStatusOf(ctx(), res)).toBe(400);
    }
    expect(tasks.get).not.toHaveBeenCalled();
  });

  it('does not know the task methods on a surface without tasks, or in the legacy era', async () => {
    expect((await call('tasks/get', { taskId: 't' }, surface())).error.code).toBe(-32601);
    const legacy = await call('tasks/get', { taskId: 't' }, surface({ tasks }), { version: '2025-11-25', era: 'legacy' } as any);
    expect(legacy.error.code).toBe(-32601);
  });

  it('needs a taskId, and inputResponses as an object on update', async () => {
    expect((await call('tasks/get', {}, surface({ tasks }))).error.code).toBe(-32602);
    expect((await call('tasks/update', { taskId: 't' }, surface({ tasks }))).error.code).toBe(-32602);
    expect((await call('tasks/update', { taskId: 't', inputResponses: [] }, surface({ tasks }))).error.code).toBe(-32602);
    expect((await call('tasks/update', { taskId: 't', inputResponses: {} }, surface({ tasks }))).result).toEqual(
      expect.objectContaining({ resultType: 'complete' }),
    );
  });

  it('shapes the result a completed task carries like any tool result', async () => {
    const s = surface({
      tasks: {
        ...tasks,
        get: async () => ({ taskId: 't', status: 'completed', result: { content: [{ type: 'text', text: 'x' }], structuredContent: [1] } }),
      },
    });
    const res = await call('tasks/get', { taskId: 't' }, s);
    expect(res.result.result).toEqual({ content: [{ type: 'text', text: 'x' }], structuredContent: [1], resultType: 'complete' });
  });

  it('never sends an input request the client did not declare, from tasks/get either', async () => {
    const asking = surface({
      tasks: { ...tasks, get: async () => ({ taskId: 't', status: 'input_required', inputRequests: { q: { method: 'elicitation/create', params: {} } } }) },
    });
    expect((await call('tasks/get', { taskId: 't' }, asking)).error.code).toBe(-32603);
    expect((await call('tasks/get', { taskId: 't' }, asking, ctx({ ...withTasks, elicitation: {} }))).result.status).toBe('input_required');
  });
});

describe('Polymorphic tools/call results in the core', () => {
  const task = { resultType: 'task', taskId: 't-9', status: 'working', createdAt: 'a', lastUpdatedAt: 'a', ttlMs: null };
  const asking = {
    resultType: 'input_required',
    inputRequests: { k: { method: 'elicitation/create', params: { mode: 'form', message: 'ok?', requestedSchema: { type: 'object', properties: {} } } } },
    requestState: 'sealed',
  };

  it('passes a task through to a request that declared the extension, and nowhere else', async () => {
    const s = surface({ callTool: async () => task as any });
    expect((await call('tools/call', { name: 'invoke_agent' }, s)).result).toMatchObject({ resultType: 'task', taskId: 't-9' });
    expect((await call('tools/call', { name: 'invoke_agent' }, s, ctx())).error.code).toBe(-32603);
    const legacy = await call('tools/call', { name: 'invoke_agent' }, s, { version: '2025-11-25', era: 'legacy' } as any);
    expect(legacy.error.code).toBe(-32603);
  });

  it('passes input_required through only to a client that declared elicitation', async () => {
    const s = surface({ callTool: async () => asking as any });
    const ok = await call('tools/call', { name: 'x' }, s, ctx({ elicitation: {} }));
    expect(ok.result).toEqual(expect.objectContaining({ resultType: 'input_required', requestState: 'sealed' }));
    expect(ok.result.ttlMs).toBeUndefined();
    expect((await call('tools/call', { name: 'x' }, s, ctx())).error.code).toBe(-32603);
  });

  it('refuses an input_required with neither inputRequests nor requestState', async () => {
    const s = surface({ callTool: async () => ({ resultType: 'input_required' }) as any });
    expect((await call('tools/call', { name: 'x' }, s, ctx({ elicitation: {} }))).error.code).toBe(-32603);
  });
});

describe('Mcp-Name on the task methods', () => {
  const body = (method: string, taskId: string) => ({
    jsonrpc: '2.0',
    id: 4,
    method,
    params: {
      taskId,
      _meta: { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': withTasks },
    },
  });

  it('must carry the task id', () => {
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      const headers = { 'mcp-protocol-version': V, 'mcp-method': method };
      expect((resolveMcpRequestVersion({ headers: { ...headers, 'mcp-name': 't-1' } }, body(method, 't-1')) as any).ctx).toBeDefined();
      expect((resolveMcpRequestVersion({ headers: { ...headers, 'mcp-name': 't-2' } }, body(method, 't-1')) as any).refusal.body.error.code).toBe(-32020);
      expect((resolveMcpRequestVersion({ headers }, body(method, 't-1')) as any).refusal.body.error.code).toBe(-32020);
    }
  });
});
