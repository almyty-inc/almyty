import { McpSurface, handleMessage, handleSingleMessage } from '../mcp-protocol-core';
import { KNOWN_PROTOCOL_VERSIONS, ProtocolVersion, isModernVersion } from '../versions';
import { restoreEnv } from '../../../../test/env';

/**
 * The protocol core, per version. One fixture surface; every claimed and
 * answered version runs the same requests, and the expected differences
 * are exactly the version table's (versions.ts).
 */
function fixtureSurface(overrides: Partial<McpSurface> = {}): McpSurface {
  return {
    serverInfo: () => ({ name: 'petstore', version: '1.0.0', title: 'Petstore' }),
    capabilities: () => ({ tools: { listChanged: false } }),
    listTools: async () => ({
      tools: [
        {
          name: 'get_pet',
          title: 'Get pet',
          description: 'Find a pet by id',
          inputSchema: { type: 'object', properties: { id: { type: 'integer', nullable: true } } },
          outputSchema: { type: 'object', properties: { name: { type: 'string' } } },
          annotations: { readOnlyHint: true, openWorldHint: true },
          icons: [{ src: 'https://example.com/pet.png' }],
        },
      ],
    }),
    callTool: async (params) => {
      if (params.name !== 'get_pet') throw { code: -32602, message: `Tool not found: ${params.name}` };
      return {
        content: [
          { type: 'text', text: '{"name":"Rex"}' },
          { type: 'resource_link', uri: 'https://api.example.com/files/1', name: 'photo.png' },
        ],
        structuredContent: { name: 'Rex' },
        isError: false,
      };
    },
    ...overrides,
  };
}

const at = (version: ProtocolVersion) => ({ version, era: 'legacy' as const });

describe('MCP protocol core', () => {
  // The legacy (initialize-based) versions; 2026-07-28 has its own spec,
  // mcp-modern.spec.ts.
  describe.each(KNOWN_PROTOCOL_VERSIONS.filter((v) => !isModernVersion(v)).map((v) => [v]))('at %s', (version) => {
    const newer = (cutoff: string) => version >= cutoff;

    it('negotiates initialize to this version', async () => {
      const res: any = await handleSingleMessage(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'c', version: '1' } } },
        fixtureSurface(),
        at(version),
      );
      expect(res.result.protocolVersion).toBe(version);
      expect(res.result.serverInfo.name).toBe('petstore');
      // Implementation.title is 2025-06-18.
      expect(res.result.serverInfo.title).toBe(newer('2025-06-18') ? 'Petstore' : undefined);
    });

    it('shapes tools/list for the version', async () => {
      const res: any = await handleSingleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, fixtureSurface(), at(version));
      const [tool] = res.result.tools;
      expect(tool.name).toBe('get_pet');
      // The 2020-12 rewrite runs on every version.
      expect(tool.inputSchema.properties.id.type).toEqual(['integer', 'null']);
      expect(tool.inputSchema.properties.id.nullable).toBeUndefined();
      expect('title' in tool).toBe(newer('2025-06-18'));
      expect('outputSchema' in tool).toBe(newer('2025-06-18'));
      expect('icons' in tool).toBe(newer('2025-11-25'));
      expect('annotations' in tool).toBe(newer('2025-03-26'));
    });

    it('shapes a tools/call result for the version', async () => {
      const res: any = await handleSingleMessage(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_pet', arguments: { id: 1 } } },
        fixtureSurface(),
        at(version),
      );
      expect(res.result.isError).toBe(false);
      expect(res.result.content[0]).toEqual({ type: 'text', text: '{"name":"Rex"}' });
      if (newer('2025-06-18')) {
        expect(res.result.structuredContent).toEqual({ name: 'Rex' });
        expect(res.result.content[1].type).toBe('resource_link');
      } else {
        expect(res.result.structuredContent).toBeUndefined();
        // An older client gets the link as text, not a block it cannot read.
        expect(res.result.content[1]).toEqual({ type: 'text', text: 'photo.png: https://api.example.com/files/1' });
      }
    });

    it('answers an unknown tool with -32602', async () => {
      const res: any = await handleSingleMessage(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } },
        fixtureSurface(),
        at(version),
      );
      expect(res.error).toEqual({ code: -32602, message: 'Tool not found: nope' });
    });

    it('answers resources/read on a surface without resources with -32602', async () => {
      const res: any = await handleSingleMessage(
        { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'x://y' } },
        fixtureSurface(),
        at(version),
      );
      expect(res.error.code).toBe(-32602);
    });

    it(newer('2025-06-18') ? 'refuses a batch' : 'accepts a batch', async () => {
      const res: any = await handleMessage(
        [
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', id: 2, method: 'ping' },
        ],
        fixtureSurface(),
        at(version),
      );
      if (newer('2025-06-18')) {
        expect(Array.isArray(res)).toBe(false);
        expect(res.error.code).toBe(-32600);
      } else {
        expect(res).toEqual([
          { jsonrpc: '2.0', id: 1, result: {} },
          { jsonrpc: '2.0', id: 2, result: {} },
        ]);
      }
    });

    it('never answers a notification', async () => {
      await expect(
        handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, fixtureSurface(), at(version)),
      ).resolves.toBeNull();
    });
  });

  it('answers an initialize without protocolVersion with -32602', async () => {
    const res: any = await handleSingleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, fixtureSurface());
    expect(res.error.code).toBe(-32602);
  });

  it('answers a method no surface has with -32601', async () => {
    const res: any = await handleSingleMessage({ jsonrpc: '2.0', id: 0, method: 'tasks/get' }, fixtureSurface());
    expect(res).toEqual({ jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'Method not found: tasks/get' } });
  });

  it('hides an internal error behind -32603', async () => {
    const res: any = await handleSingleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      fixtureSurface({ listTools: async () => { throw new Error('db password is hunter2'); } }),
    );
    expect(res.error).toEqual({ code: -32603, message: 'Internal server error' });
  });

  it('reports each answered request to the surface, and none for a notification', async () => {
    const onOutcome = jest.fn();
    const surface = fixtureSurface({ onOutcome });
    await handleSingleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }, surface);
    await handleSingleMessage({ jsonrpc: '2.0', id: 2, method: 'no/such' }, surface);
    await handleSingleMessage({ jsonrpc: '2.0', method: 'ping' }, surface);
    expect(onOutcome.mock.calls).toEqual([[true], [false]]);
  });

  it('negotiates within MCP_PROTOCOL_VERSIONS when it is set', async () => {
    const prior = process.env.MCP_PROTOCOL_VERSIONS;
    process.env.MCP_PROTOCOL_VERSIONS = '2025-06-18,2025-03-26';
    try {
      const res: any = await handleSingleMessage(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } } },
        fixtureSurface(),
      );
      expect(res.result.protocolVersion).toBe('2025-06-18');
    } finally {
      restoreEnv('MCP_PROTOCOL_VERSIONS', prior);
    }
  });
});
