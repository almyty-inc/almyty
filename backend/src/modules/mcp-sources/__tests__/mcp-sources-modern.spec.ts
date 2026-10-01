import { FindOperator } from 'typeorm';

import { McpSourcesService, __testing } from '../mcp-sources.service';
import { McpClientService } from '../mcp-client.service';
import { McpSource, McpSourceStatus } from '../../../entities/mcp-source.entity';
import { MessageRole } from '../../../entities/message.entity';
import { FakeRedis } from '../../../test/fake-redis';
import { unlimitedToolQuotaManager } from '../../../test/tool-quota.fake';
import { snapshotEnv } from '../../../test/env';

/**
 * mcp-sources against a 2026-07-28 server: what a sync keeps of the remote
 * definitions (title, annotations, icons, output schema, era), tools the
 * client refused, and a remote's question inside and outside an agent run.
 * The MCP client is the real one; the server is a scripted fetch.
 */
const MODERN = '2026-07-28';
const RUN = 'run-1';

type Sent = { method: string; params: any; headers: Record<string, string>; id?: number };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function source(over: Partial<McpSource> = {}): McpSource {
  return {
    id: 'src-1',
    name: 'warehouse',
    description: null,
    url: 'https://mcp.example.com/mcp',
    authType: 'none',
    authConfig: null,
    credentialId: null,
    status: McpSourceStatus.ACTIVE,
    lastSyncAt: null,
    lastError: null,
    toolCount: 0,
    serverInfo: null,
    organizationId: 'org-1',
    createdBy: 'user-1',
    ...over,
  } as McpSource;
}

/** Messages, with the one clause the service uses evaluated, not matched blindly. */
function messageRepo(rows: Array<{ runId: string; role: MessageRole; content: string; createdAt: Date }>) {
  return {
    findOne: jest.fn(async ({ where, order }: any) => {
      const after = where.createdAt as FindOperator<Date>;
      expect(after.type).toBe('moreThan');
      const matching = rows
        .filter((m) => m.runId === where.runId && m.role === where.role && m.createdAt > after.value)
        .sort((a, b) => (order?.createdAt === 'DESC' ? b.createdAt.getTime() - a.createdAt.getTime() : 0));
      return matching[0] ?? null;
    }),
  };
}

function setup(handler: (m: Sent) => Response, opts: { messages?: any[]; redis?: FakeRedis | null } = {}) {
  const sent: Sent[] = [];
  (global as any).fetch = jest.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const msg = { method: body.method, params: body.params, headers: init.headers, id: body.id };
    sent.push(msg);
    return handler(msg);
  });
  const src = source();
  const sourceRepository: any = {
    findOne: jest.fn(async () => src),
    save: jest.fn(async (x: any) => x),
  };
  const saved: any[] = [];
  const schemas: any[] = [];
  const toolRepository: any = {
    get manager() {
      const base = unlimitedToolQuotaManager(this);
      return {
        ...base,
        transaction: async (work: any) =>
          base.transaction(async (tx: any) =>
            work({
              ...tx,
              getRepository: (entity: any) =>
                entity?.name === 'JsonSchema'
                  ? {
                      findOne: async ({ where }: any) => schemas.find((s) => s.id === where.id) ?? null,
                      create: (x: any) => x,
                      save: async (x: any) => {
                        if (!x.id) x.id = `schema-${schemas.length + 1}`;
                        if (!schemas.includes(x)) schemas.push(x);
                        return x;
                      },
                      remove: async (x: any) => schemas.splice(schemas.indexOf(x), 1),
                    }
                  : tx.getRepository(entity),
            }),
          ),
      };
    },
    find: jest.fn(async () => []),
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => {
      saved.push(x);
      return { id: `tool-${x.name}`, ...x };
    }),
  };
  const redis = opts.redis === undefined ? new FakeRedis() : opts.redis;
  const service = new McpSourcesService(
    sourceRepository,
    toolRepository,
    new McpClientService(),
    {} as any,
    {} as any,
    undefined,
    messageRepo(opts.messages ?? []) as any,
    (redis ?? undefined) as any,
  );
  return { service, sent, src, saved, schemas, sourceRepository, redis };
}

const discover = (m: Sent) =>
  json({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', supportedVersions: [MODERN], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'warehouse-mcp', version: '3.1.0' } } } });

describe('McpSourcesService on MCP 2026-07-28', () => {
  const restore = snapshotEnv('MCP_CLIENT_ERA', 'MCP_CLIENT_PENDING_INPUT_SECONDS', 'MCP_CLIENT_TASK_POLL_MIN_MS', 'MCP_CLIENT_TASK_POLL_MAX_MS', 'MCP_CLIENT_RUN_CANCEL_CHECK_MS');
  const realFetch = global.fetch;
  afterEach(() => {
    (global as any).fetch = realFetch;
    restore();
  });

  describe('sync', () => {
    const listing = {
      tools: [
        {
          name: 'stock_level',
          title: 'Stock level',
          description: 'How many units are in stock',
          inputSchema: { type: 'object', properties: { sku: { type: 'string', 'x-mcp-header': 'Sku' } } },
          outputSchema: { type: 'object', properties: { units: { type: 'integer' } }, required: ['units'] },
          annotations: { readOnlyHint: true, openWorldHint: false },
          icons: [{ src: 'https://cdn.example.com/box.svg' }],
        },
        { name: 'broken', inputSchema: { type: 'object', properties: { n: { type: 'number', 'x-mcp-header': 'N' } } } },
      ],
    };

    it('keeps title, annotations, icons and the output schema, and remembers the era', async () => {
      const { service, saved, schemas, src } = setup((m) =>
        m.method === 'server/discover' ? discover(m) : json({ jsonrpc: '2.0', id: m.id, result: listing }),
      );
      const summary = await service.sync('src-1', 'org-1', 'user-1');

      expect(summary).toEqual({ added: 1, updated: 0, removed: 0, total: 1, rejected: [{ name: 'broken', reason: expect.stringContaining('number parameter') }] });
      const tool = saved.find((t) => t.name === 'warehouse_stock_level');
      expect(tool.configuration.mcp).toEqual({
        sourceId: 'src-1',
        remoteName: 'stock_level',
        inputSchema: listing.tools[0].inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
        icons: [{ src: 'https://cdn.example.com/box.svg' }],
      });
      expect(tool.metadata).toMatchObject({ title: 'Stock level', mcpSource: { id: 'src-1' } });
      expect(schemas).toEqual([expect.objectContaining({ schema: listing.tools[0].outputSchema, type: 'output', metadata: { mcpSourceId: 'src-1', remoteName: 'stock_level' } })]);
      expect(tool.outputSchemaId).toBe(schemas[0].id);
      expect(src.serverInfo).toEqual({ name: 'warehouse-mcp', version: '3.1.0', protocolVersion: MODERN, era: 'modern' });
      expect(src.lastError).toContain('broken');
    });
  });

  describe('a remote that asks a person something', () => {
    const asks = (m: Sent) =>
      json({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          resultType: 'input_required',
          inputRequests: {
            confirm: { method: 'elicitation/create', params: { mode: 'form', message: 'Which warehouse, Berlin or Leipzig?', requestedSchema: { type: 'object', properties: { warehouse: { type: 'string', enum: ['Berlin', 'Leipzig'] } }, required: ['warehouse'] } } },
          },
          requestState: 'state-abc',
        },
      });
    const modernSource = { serverInfo: { era: 'modern' as const, protocolVersion: MODERN } };

    it('outside an agent run: a tool error that says what it wanted, and nothing is kept', async () => {
      const ctx = setup((m) => asks(m));
      Object.assign(ctx.src, modernSource);
      const result = await ctx.service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'reserve' }, { sku: 'A1' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Which warehouse, Berlin or Leipzig?');
      expect(result.error).toContain('cannot ask');
      // No elicitation declared where nobody can be asked.
      expect(ctx.sent[0].params._meta['io.modelcontextprotocol/clientCapabilities'].elicitation).toBeUndefined();
      expect(ctx.redis!.keys()).toEqual([]);
    });

    it('inside a run: sends the model to the person, waits for the answer, then retries with it', async () => {
      const messages: any[] = [];
      let calls = 0;
      const ctx = setup(
        (m) => {
          calls++;
          if (m.params.requestState) return json({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"reserved":true}' }] } });
          return asks(m);
        },
        { messages },
      );
      Object.assign(ctx.src, modernSource);
      const options = { runId: RUN, canAskPerson: true };

      const first = await ctx.service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'reserve' }, { sku: 'A1', qty: 2 }, options);
      expect(first.success).toBe(false);
      expect(first.error).toContain('ask_user');
      expect(first.error).toContain('Which warehouse, Berlin or Leipzig?');
      expect(ctx.sent[0].params._meta['io.modelcontextprotocol/clientCapabilities'].elicitation).toEqual({ form: {} });

      // Called again before the person answered: the server is not asked again.
      const early = await ctx.service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'reserve' }, { qty: 2, sku: 'A1' }, options);
      expect(early.error).toContain('ask_user');
      expect(calls).toBe(1);

      messages.push({ runId: RUN, role: MessageRole.USER, content: 'leipzig', createdAt: new Date(Date.now() + 1000) });
      const done = await ctx.service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'reserve' }, { sku: 'A1', qty: 2 }, options);
      expect(done).toEqual({ success: true, data: { reserved: true } });
      expect(ctx.sent[1].params).toMatchObject({
        arguments: { sku: 'A1', qty: 2 },
        requestState: 'state-abc',
        inputResponses: { confirm: { action: 'accept', content: { warehouse: 'Leipzig' } } },
      });
      expect(ctx.redis!.keys()).toEqual([]);
    });

    it('treats other arguments as a new call, and a message from another run as no answer', async () => {
      const messages: any[] = [{ runId: 'run-2', role: MessageRole.USER, content: 'Berlin', createdAt: new Date(Date.now() + 1000) }];
      const ctx = setup((m) => asks(m), { messages });
      Object.assign(ctx.src, modernSource);
      const options = { runId: RUN, canAskPerson: true };
      await ctx.service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'reserve' }, { sku: 'A1' }, options);
      const again = await ctx.service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'reserve' }, { sku: 'A1' }, options);
      expect(again.error).toContain('ask_user');
      expect(ctx.sent).toHaveLength(1);
      await ctx.service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'reserve' }, { sku: 'B2' }, options);
      expect(ctx.sent).toHaveLength(2);
    });

    it('without Redis, an agent run gets the "cannot ask" error rather than a question it could never answer', async () => {
      const ctx = setup((m) => asks(m), { redis: null });
      Object.assign(ctx.src, modernSource);
      const result = await ctx.service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'reserve' }, {}, { runId: RUN, canAskPerson: true });
      expect(result.error).toContain('cannot ask');
    });

    it('cancels a remote task waiting for input when nobody can answer it', async () => {
      const ctx = setup((m) => {
        if (m.method === 'tools/call') return json({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't-7', status: 'working', pollIntervalMs: 1 } });
        if (m.method === 'tasks/get') return json({ jsonrpc: '2.0', id: m.id, result: { taskId: 't-7', status: 'input_required', inputRequests: { q: { method: 'elicitation/create', params: { message: 'Sure?', requestedSchema: { type: 'object', properties: {} } } } } } });
        return json({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete' } });
      });
      Object.assign(ctx.src, modernSource);
      process.env.MCP_CLIENT_TASK_POLL_MIN_MS = '50';
      const result = await ctx.service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'reserve' }, {});
      expect(result.error).toContain('Sure?');
      expect(ctx.sent.find((s) => s.method === 'tasks/cancel')?.params.taskId).toBe('t-7');
    });
  });

  describe('a remote task when the agent run ends', () => {
    it('is cancelled on the server once the run is cancelled', async () => {
      process.env.MCP_CLIENT_TASK_POLL_MIN_MS = '50';
      process.env.MCP_CLIENT_TASK_POLL_MAX_MS = '50';
      process.env.MCP_CLIENT_RUN_CANCEL_CHECK_MS = '100';
      const run = { id: RUN, status: 'running' };
      const ctx = setup((m) => {
        if (m.method === 'tools/call') return json({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't-run', status: 'working', pollIntervalMs: 50 } });
        if (m.method === 'tasks/get') {
          run.status = 'cancelled';
          return json({ jsonrpc: '2.0', id: m.id, result: { taskId: 't-run', status: 'working' } });
        }
        return json({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete' } });
      });
      Object.assign(ctx.src, { serverInfo: { era: 'modern', protocolVersion: MODERN } });
      (ctx.service as any).runRepository = {
        findOne: jest.fn(async ({ where }: any) => (where.id === RUN ? { ...run } : null)),
      };
      await expect(
        ctx.service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'long' }, {}, { runId: RUN, canAskPerson: true }),
      ).rejects.toMatchObject({ code: 'MCP_TIMEOUT', message: expect.stringContaining('cancelled with its call') });
      expect(ctx.sent.find((s) => s.method === 'tasks/cancel')?.params.taskId).toBe('t-run');
    });
  });

  describe('answers as form content', () => {
    const { inputResponsesFrom } = __testing;
    const form = (properties: Record<string, any>) => ({ q: { method: 'elicitation/create', params: { mode: 'form', message: 'm', requestedSchema: { type: 'object', properties } } } });

    it('fills a single field by its type', () => {
      expect(inputResponsesFrom(form({ n: { type: 'integer' } }), '1,250')).toEqual({ q: { action: 'accept', content: { n: 1250 } } });
      expect(inputResponsesFrom(form({ ok: { type: 'boolean' } }), 'Yes')).toEqual({ q: { action: 'accept', content: { ok: true } } });
      expect(inputResponsesFrom(form({ c: { type: 'string', oneOf: [{ const: 'red', title: 'Red' }] } }), 'RED')).toEqual({ q: { action: 'accept', content: { c: 'red' } } });
    });

    it('fills several fields from a JSON answer, else puts the text in the first text field', () => {
      const props = { count: { type: 'integer' }, note: { type: 'string' } };
      expect(inputResponsesFrom(form(props), '{"count": 3, "note": "rush"}')).toEqual({ q: { action: 'accept', content: { count: 3, note: 'rush' } } });
      expect(inputResponsesFrom(form(props), 'rush it')).toEqual({ q: { action: 'accept', content: { note: 'rush it' } } });
    });

    it('accepts a URL elicitation as done and answers roots with none', () => {
      expect(inputResponsesFrom({ u: { method: 'elicitation/create', params: { mode: 'url', message: 'Sign in', url: 'https://x' } }, r: { method: 'roots/list' } }, 'done')).toEqual({
        u: { action: 'accept' },
        r: { roots: [] },
      });
    });
  });
});
