import 'reflect-metadata';

import { McpToolHandler } from '../services/mcp-tool.handler';
import { ToolStatus } from '../../../entities/tool.entity';
import { snapshotEnv } from '../../../test/env';

/**
 * tools/list carries title, annotations, outputSchema and icons in a stable
 * order; tools/call returns structuredContent next to the text block, holds
 * a result to the output schema the tool declared, and turns invalid
 * arguments into a tool error rather than a protocol error.
 */
describe('MCP tool results (2025-06-18 / 2025-11-25)', () => {
  const restore = snapshotEnv('MCP_EMIT_OUTPUT_SCHEMA', 'MCP_TOOLS_LIST_CACHE_SECONDS', 'ENCRYPTION_KEY', 'MCP_HELD_CALL_WAIT_MS');
  afterEach(restore);

  const gateway = { id: 'gw-1', organizationId: 'org-1', visibility: 'org', teamId: null, ownerUserId: null, isSystem: false };
  const tool = (over: Record<string, any>) => ({
    id: `t-${over.name}`,
    organizationId: 'org-1',
    status: ToolStatus.ACTIVE,
    visibility: 'org',
    parameters: { type: 'object', properties: { id: { type: 'integer', required: true } } },
    ...over,
  });

  let executor: { executeTool: jest.Mock };
  let redis: any;
  let rows: any[];
  let handler: McpToolHandler;

  beforeEach(() => {
    executor = { executeTool: jest.fn() };
    redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };
    rows = [];
    const gatewayToolRepository: any = {
      find: jest.fn(async () => rows.map((t) => ({ isActive: true, tool: t, gateway }))),
      manager: { getRepository: () => ({ findOne: jest.fn().mockResolvedValue(gateway) }) },
    };
    handler = new McpToolHandler(
      { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } as any,
      gatewayToolRepository,
      { find: jest.fn().mockResolvedValue([]) } as any,
      { getTools: jest.fn(), findByName: jest.fn() } as any,
      executor as any,
      redis,
    );
  });

  const petSchema = { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } };

  describe('tools/list', () => {
    it('lists title, annotations, outputSchema and icons', async () => {
      rows = [
        tool({
          name: 'get_pet_by_id',
          description: 'Find a pet',
          operation: { method: 'GET' },
          outputSchema: petSchema,
          metadata: { icons: [{ src: 'https://cdn.example.com/pet.svg', mimeType: 'image/svg+xml' }] },
        }),
      ];
      const { tools } = await handler.handleToolsList({}, 'org-1', 'gw-1');
      expect(tools[0]).toEqual({
        name: 'get_pet_by_id',
        title: 'Get pet by id',
        description: 'Find a pet',
        inputSchema: { type: 'object', properties: { id: { type: 'integer', required: true } } },
        outputSchema: petSchema.schema,
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
        icons: [{ src: 'https://cdn.example.com/pet.svg', mimeType: 'image/svg+xml' }],
      });
    });

    it('marks a DELETE as destructive and a POST as a plain write', async () => {
      rows = [tool({ name: 'delete_pet', operation: { method: 'DELETE' } }), tool({ name: 'add_pet', operation: { method: 'POST' } })];
      const { tools } = await handler.handleToolsList({}, 'org-1', 'gw-1');
      const byName = Object.fromEntries(tools.map((t: any) => [t.name, t.annotations]));
      expect(byName.delete_pet).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
      expect(byName.add_pet).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    });

    it('lists a gateway in the same order every time: by name, then id', async () => {
      rows = [tool({ name: 'zebra' }), tool({ name: 'alpha', id: 't-2' }), tool({ name: 'alpha', id: 't-1' }), tool({ name: 'Mango' })];
      const { tools } = await handler.handleToolsList({}, 'org-1', 'gw-1');
      expect(tools.map((t: any) => t.name)).toEqual(['Mango', 'alpha', 'alpha', 'zebra']);
      rows = [...rows].reverse();
      redis.get.mockResolvedValue(null);
      const again = await handler.handleToolsList({}, 'org-1', 'gw-1');
      expect(again.tools).toEqual(tools);
    });

    it('declares no outputSchema for a schema that is not an object, or when MCP_EMIT_OUTPUT_SCHEMA=false', async () => {
      rows = [tool({ name: 'list_pets', outputSchema: { schema: { type: 'array', items: {} } } })];
      expect((await handler.handleToolsList({}, 'org-1', 'gw-1')).tools[0].outputSchema).toBeUndefined();

      process.env.MCP_EMIT_OUTPUT_SCHEMA = 'false';
      rows = [tool({ name: 'get_pet', outputSchema: petSchema })];
      expect((await handler.handleToolsList({}, 'org-1', 'gw-1')).tools[0].outputSchema).toBeUndefined();
    });

    it('caches for MCP_TOOLS_LIST_CACHE_SECONDS, and not at all at 0', async () => {
      process.env.MCP_TOOLS_LIST_CACHE_SECONDS = '15';
      await handler.handleToolsList({}, 'org-1', 'gw-1');
      expect(redis.setex.mock.calls[0][1]).toBe(15);

      process.env.MCP_TOOLS_LIST_CACHE_SECONDS = '0';
      redis.setex.mockClear();
      await handler.handleToolsList({}, 'org-1', 'gw-1');
      expect(redis.setex).not.toHaveBeenCalled();
    });
  });

  describe('tools/call', () => {
    it('returns structuredContent next to the serialized text', async () => {
      rows = [tool({ name: 'get_pet' })];
      executor.executeTool.mockResolvedValue({ success: true, data: { name: 'Rex' } });
      const result = await handler.handleToolCall({ name: 'get_pet', arguments: { id: 1 } }, 'org-1', 'u-1', 'gw-1');
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ name: 'Rex' }, null, 2) }],
        structuredContent: { name: 'Rex' },
        isError: false,
      });
    });

    it('keeps an array or a string result as text only', async () => {
      rows = [tool({ name: 'list_pets' })];
      executor.executeTool.mockResolvedValue({ success: true, data: [{ name: 'Rex' }] });
      const result = await handler.handleToolCall({ name: 'list_pets' }, 'org-1', 'u-1', 'gw-1');
      expect(result.structuredContent).toBeUndefined();
      expect(result.isError).toBe(false);
    });

    it('holds a result to the declared output schema, and reports a mismatch as a tool error carrying the data', async () => {
      rows = [tool({ name: 'get_pet', outputSchema: petSchema })];
      executor.executeTool.mockResolvedValue({ success: true, data: { name: 'Rex' } });
      const ok = await handler.handleToolCall({ name: 'get_pet' }, 'org-1', 'u-1', 'gw-1');
      expect(ok.structuredContent).toEqual({ name: 'Rex' });

      executor.executeTool.mockResolvedValue({ success: true, data: { nickname: 'Rex' } });
      const bad = await handler.handleToolCall({ name: 'get_pet' }, 'org-1', 'u-1', 'gw-1');
      expect(bad.isError).toBe(true);
      expect(bad.structuredContent).toBeUndefined();
      expect((bad.content[0] as any).text).toContain('did not match its declared output schema');
      expect((bad.content[0] as any).text).toContain('nickname');
    });

    // SEP-1303 (2025-11-25): invalid arguments come back as a tool error the
    // model can read and correct, not as a protocol error.
    it('answers invalid arguments with isError, not a protocol error', async () => {
      rows = [tool({ name: 'get_pet' })];
      executor.executeTool.mockRejectedValue(new Error('Invalid parameters: id is required'));
      const result = await handler.handleToolCall({ name: 'get_pet', arguments: {} }, 'org-1', 'u-1', 'gw-1');
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('id is required');
    });

    it('answers an unknown tool with -32602', async () => {
      await expect(handler.handleToolCall({ name: 'nope' }, 'org-1', 'u-1', 'gw-1')).rejects.toEqual(
        expect.objectContaining({ code: -32602, message: 'Tool not found: nope' }),
      );
    });

    describe('a held call on a 2026-07-28 client (input_required)', () => {
      const elicits = { version: '2026-07-28' as any, era: 'modern' as const, clientCapabilities: { elicitation: {} } };
      const heldResult = {
        success: false,
        error: 'Waiting for approval',
        approvalRequired: { summary: 'Ask before refund when amount is over 500' },
        approvalStatus: 'pending',
        approvalId: 'appr-1',
      };
      let approvals: any;
      let withApprovals: McpToolHandler;

      beforeEach(() => {
        process.env.ENCRYPTION_KEY = 'e'.repeat(64);
        approvals = {
          row: { id: 'appr-1', organizationId: 'org-1', status: 'pending', reason: 'Refund over 500', payload: { tool: 'Refund' } },
          findInOrganization: jest.fn(async () => approvals.row),
          canDecide: jest.fn(async (row: any, caller: any) => row.status === 'pending' && caller?.id === 'u-1'),
          approve: jest.fn(async () => {
            approvals.row = { ...approvals.row, status: 'approved' };
            return approvals.row;
          }),
          reject: jest.fn(),
        };
        const gatewayToolRepository: any = {
          find: jest.fn(async () => rows.map((t) => ({ isActive: true, tool: t, gateway }))),
          manager: { getRepository: () => ({ findOne: jest.fn().mockResolvedValue(gateway) }) },
        };
        withApprovals = new McpToolHandler(
          { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } as any,
          gatewayToolRepository,
          { find: jest.fn().mockResolvedValue([]) } as any,
          { getTools: jest.fn(), findByName: jest.fn() } as any,
          executor as any,
          redis,
          undefined,
          { get: () => approvals } as any,
        );
        rows = [tool({ name: 'refund' })];
      });

      it('asks the approver, then runs the call with the approval on the retry', async () => {
        executor.executeTool.mockResolvedValueOnce(heldResult);
        const params = { name: 'refund', arguments: { amount: 820 } };
        const asked: any = await withApprovals.handleToolCall(params, 'org-1', 'u-1', 'gw-1', undefined, elicits);
        expect(asked.resultType).toBe('input_required');

        executor.executeTool.mockResolvedValueOnce({ success: true, data: { refunded: true } });
        const done: any = await withApprovals.handleToolCall(
          { ...params, requestState: asked.requestState, inputResponses: { 'approval-appr-1': { action: 'accept', content: { decision: 'approve' } } } } as any,
          'org-1', 'u-1', 'gw-1', undefined, elicits,
        );
        expect(approvals.approve).toHaveBeenCalled();
        expect(executor.executeTool).toHaveBeenLastCalledWith(expect.any(String), { amount: 820, _approvalId: 'appr-1' }, expect.anything());
        expect(done).toEqual({ content: [{ type: 'text', text: expect.stringContaining('refunded') }], structuredContent: { refunded: true }, isError: false });
      });

      it('keeps the waiting answer for someone who could not approve it', async () => {
        executor.executeTool.mockResolvedValueOnce(heldResult);
        const result: any = await withApprovals.handleToolCall({ name: 'refund', arguments: { amount: 820 } }, 'org-1', 'u-2', 'gw-1', undefined, elicits);
        expect(result).toEqual({ content: [{ type: 'text', text: 'Waiting for approval' }], isError: true });
      });
    });

    describe('Mcp-Param-* headers (2026-07-28)', () => {
      const regional = () =>
        tool({ name: 'list_pets', parameters: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } } });

      it('runs the tool when the header agrees with the argument', async () => {
        rows = [regional()];
        executor.executeTool.mockResolvedValue({ success: true, data: [] });
        const result = await handler.handleToolCall({ name: 'list_pets', arguments: { region: 'eu' } }, 'org-1', 'u-1', 'gw-1', {
          'mcp-param-region': 'eu',
        });
        expect(result.isError).toBeFalsy();
        expect(executor.executeTool).toHaveBeenCalledTimes(1);
      });

      it('refuses a disagreeing header with -32020 before running anything', async () => {
        rows = [regional()];
        await expect(
          handler.handleToolCall({ name: 'list_pets', arguments: { region: 'eu' } }, 'org-1', 'u-1', 'gw-1', { 'mcp-param-region': 'us' }),
        ).rejects.toEqual(expect.objectContaining({ code: -32020 }));
        expect(executor.executeTool).not.toHaveBeenCalled();
      });

      it('does not check headers for a legacy request', async () => {
        rows = [regional()];
        executor.executeTool.mockResolvedValue({ success: true, data: [] });
        await handler.handleToolCall({ name: 'list_pets', arguments: { region: 'eu' } }, 'org-1', 'u-1', 'gw-1');
        expect(executor.executeTool).toHaveBeenCalledTimes(1);
      });
    });
  });
});
