import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { AlmytyMcpService } from '../almyty-mcp.service';

describe('AlmytyMcpService', () => {
  let service: AlmytyMcpService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlmytyMcpService,
        {
          provide: ModuleRef,
          useValue: { get: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(AlmytyMcpService);
  });

  const call = (method: string, params?: any) =>
    service.handleJsonRpc({ jsonrpc: '2.0', id: 1, method, params }, 'org-1', 'user-1');

  describe('initialize', () => {
    it('returns server info and capabilities', async () => {
      const res = await call('initialize');
      expect(res.result.serverInfo.name).toBe('almyty');
      expect(res.result.capabilities.tools).toBeDefined();
      expect(res.result.protocolVersion).toBe('2024-11-05');
    });
  });

  describe('tools/list', () => {
    it('returns all built-in tools', async () => {
      const res = await call('tools/list');
      expect(res.result.tools.length).toBeGreaterThan(0);
      expect(res.result.tools[0]).toHaveProperty('name');
      expect(res.result.tools[0]).toHaveProperty('description');
      expect(res.result.tools[0]).toHaveProperty('inputSchema');
    });

    it('includes expected tool names', async () => {
      const res = await call('tools/list');
      const names = res.result.tools.map((t: any) => t.name);
      expect(names).toContain('list_apis');
      expect(names).toContain('list_tools');
      expect(names).toContain('list_gateways');
      expect(names).toContain('list_agents');
      expect(names).toContain('create_agent');
    });
  });

  describe('resources/list', () => {
    it('returns empty resources array', async () => {
      const res = await call('resources/list');
      expect(res.result.resources).toEqual([]);
    });
  });

  describe('resources/read', () => {
    it('returns error for any resource', async () => {
      const res = await call('resources/read', { uri: 'test://foo' });
      expect(res.error.code).toBe(-32602);
    });
  });

  describe('prompts/list', () => {
    it('returns empty prompts array', async () => {
      const res = await call('prompts/list');
      expect(res.result.prompts).toEqual([]);
    });
  });

  describe('prompts/get', () => {
    it('returns valid message response', async () => {
      const res = await call('prompts/get', { name: 'test-prompt' });
      expect(res.result.messages).toBeDefined();
      expect(res.result.messages[0].role).toBe('user');
    });
  });

  describe('ping', () => {
    it('returns empty result', async () => {
      const res = await call('ping');
      expect(res.result).toEqual({});
    });
  });

  describe('notifications/initialized', () => {
    it('returns empty result', async () => {
      const res = await call('notifications/initialized');
      expect(res.result).toEqual({});
    });
  });

  describe('unknown method', () => {
    it('returns -32601 error', async () => {
      const res = await call('bogus/method');
      expect(res.error.code).toBe(-32601);
      expect(res.error.message).toContain('bogus/method');
    });
  });

  describe('tools/call', () => {
    it('returns error for unknown tool', async () => {
      const res = await call('tools/call', { name: 'nonexistent_tool', arguments: {} });
      expect(res.result.content[0].text).toContain('Unknown tool');
      expect(res.result.isError).toBe(true);
    });
  });
});
