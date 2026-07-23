import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';

import { McpSourcesService } from '../mcp-sources.service';
import { McpClientService, McpClientError } from '../mcp-client.service';
import { McpSource, McpSourceStatus } from '../../../entities/mcp-source.entity';
import { Tool, ToolType, ToolStatus } from '../../../entities/tool.entity';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { encryptField, decryptField, isEncrypted } from '../../../common/security/field-crypto';

describe('McpSourcesService', () => {
  let service: McpSourcesService;
  let sourceRepository: any;
  let toolRepository: any;
  let mcpClient: any;

  const baseSource = (): McpSource =>
    ({
      id: 'src-1',
      name: 'weather',
      description: null,
      url: 'https://mcp.example.com/mcp',
      authType: 'none',
      authConfig: null,
      status: McpSourceStatus.ACTIVE,
      lastSyncAt: null,
      lastError: null,
      toolCount: 0,
      serverInfo: null,
      organizationId: 'org-1',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as McpSource;

  const remoteListing = (tools: Array<{ name: string; description?: string; inputSchema?: any }>) => ({
    tools,
    init: {
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'fixture-server', version: '1.0.0' },
      sessionId: null,
      capabilities: {},
    },
  });

  beforeEach(async () => {
    sourceRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => ({ id: 'src-1', ...x })),
      remove: jest.fn(async (x: any) => x),
    };
    toolRepository = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => ({ id: `tool-${x.name}`, ...x })),
      remove: jest.fn(async (x: any) => x),
    };
    mcpClient = {
      assertUrlAllowed: jest.fn(),
      listTools: jest.fn(),
      callTool: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpSourcesService,
        { provide: EnvelopeCryptoService, useValue: makeEnvelopeCryptoMock() },
        { provide: getRepositoryToken(McpSource), useValue: sourceRepository },
        { provide: getRepositoryToken(Tool), useValue: toolRepository },
        { provide: McpClientService, useValue: mcpClient },
      ],
    }).compile();

    service = module.get(McpSourcesService);
  });

  describe('create', () => {
    it('creates the source, runs the initial sync, and materializes remote tools as type=mcp', async () => {
      sourceRepository.findOne
        .mockResolvedValueOnce(null) // duplicate-name check
        .mockResolvedValueOnce(baseSource()) // getOwned inside sync
        .mockResolvedValueOnce({ ...baseSource(), toolCount: 2, status: McpSourceStatus.ACTIVE }); // fresh reload
      mcpClient.listTools.mockResolvedValue(
        remoteListing([
          { name: 'get_weather', description: 'Forecast', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
          { name: 'get_alerts', inputSchema: { type: 'object' } },
        ]),
      );

      const result = await service.create(
        { name: 'weather', url: 'https://mcp.example.com/mcp' },
        'org-1',
        'user-1',
      );

      expect(mcpClient.assertUrlAllowed).toHaveBeenCalledWith('https://mcp.example.com/mcp');
      expect(result.sync).toEqual({ added: 2, updated: 0, removed: 0, total: 2 });
      expect(result.syncError).toBeNull();
      expect(result.source.toolCount).toBe(2);
      expect((result.source as any).authConfig).toBeUndefined();

      // Two Tool rows materialized with the mcp configuration pointer.
      const savedTools = toolRepository.save.mock.calls.map((c: any[]) => c[0]);
      expect(savedTools).toHaveLength(2);
      expect(savedTools[0]).toMatchObject({
        name: 'weather_get_weather',
        type: ToolType.MCP,
        status: ToolStatus.ACTIVE,
        organizationId: 'org-1',
        configuration: {
          mcp: { sourceId: 'src-1', remoteName: 'get_weather' },
        },
      });
      expect(savedTools[0].parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
      expect(savedTools[0].definitionHash).toEqual(expect.any(String));
    });

    it('encrypts the bearer token at rest and never returns authConfig', async () => {
      sourceRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(baseSource())
        .mockResolvedValueOnce(baseSource());
      mcpClient.listTools.mockResolvedValue(remoteListing([]));

      await service.create(
        { name: 'weather', url: 'https://mcp.example.com/mcp', bearerToken: 'super-secret' },
        'org-1',
      );

      const persisted = sourceRepository.save.mock.calls[0][0];
      expect(persisted.authType).toBe('bearer');
      expect(persisted.authConfig.bearerToken).not.toContain('super-secret');
      expect(isEncrypted(persisted.authConfig.bearerToken)).toBe(true);
      expect(decryptField(persisted.authConfig.bearerToken)).toBe('super-secret');
    });

    it('keeps the source but reports the error when the initial sync fails', async () => {
      const src = baseSource();
      sourceRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(src)
        .mockResolvedValueOnce({ ...src, status: McpSourceStatus.ERROR, lastError: 'MCP server returned HTTP 401 for initialize' });
      mcpClient.listTools.mockRejectedValue(
        new McpClientError('MCP_HTTP_ERROR', 'MCP server returned HTTP 401 for initialize'),
      );

      const result = await service.create(
        { name: 'weather', url: 'https://mcp.example.com/mcp' },
        'org-1',
      );

      expect(result.sync).toBeNull();
      expect(result.syncError).toContain('HTTP 401');
      expect(result.source.status).toBe(McpSourceStatus.ERROR);
    });

    it('rejects duplicate names within the organization', async () => {
      sourceRepository.findOne.mockResolvedValueOnce(baseSource());
      await expect(
        service.create({ name: 'weather', url: 'https://mcp.example.com/mcp' }, 'org-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects blocked URLs before persisting anything', async () => {
      mcpClient.assertUrlAllowed.mockImplementation(() => {
        throw new McpClientError('MCP_URL_BLOCKED', 'MCP server URL rejected: Blocked private/reserved IP');
      });
      await expect(
        service.create({ name: 'internal', url: 'http://10.0.0.5/mcp' }, 'org-1'),
      ).rejects.toMatchObject({ code: 'MCP_URL_BLOCKED' });
      expect(sourceRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('sync (re-sync diffing)', () => {
    const materialized = (remoteName: string, overrides: Partial<Tool> = {}): Tool =>
      ({
        id: `tool-${remoteName}`,
        name: `weather_${remoteName}`,
        description: 'old description',
        type: ToolType.MCP,
        status: ToolStatus.ACTIVE,
        organizationId: 'org-1',
        parameters: { type: 'object' },
        configuration: { timeout: 30000, mcp: { sourceId: 'src-1', remoteName } },
        ...overrides,
      }) as Tool;

    it('updates kept tools, inserts new ones, and marks vanished ones inactive', async () => {
      sourceRepository.findOne.mockResolvedValue(baseSource());
      toolRepository.find.mockResolvedValue([
        materialized('get_weather'),
        materialized('get_tides'), // gone on the remote now
        // Same org, different source — must be untouched.
        materialized('other_tool', {
          configuration: { mcp: { sourceId: 'src-OTHER', remoteName: 'other_tool' } } as any,
        }),
      ]);
      mcpClient.listTools.mockResolvedValue(
        remoteListing([
          { name: 'get_weather', description: 'new description', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
          { name: 'get_alerts', inputSchema: { type: 'object' } },
        ]),
      );

      const summary = await service.sync('src-1', 'org-1');

      expect(summary).toEqual({ added: 1, updated: 1, removed: 1, total: 2 });

      const savedTools = toolRepository.save.mock.calls.map((c: any[]) => c[0]);
      const updated = savedTools.find((t: any) => t.id === 'tool-get_weather');
      expect(updated.description).toBe('new description');
      expect(updated.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
      expect(updated.status).toBe(ToolStatus.ACTIVE);

      const inactive = savedTools.find((t: any) => t.id === 'tool-get_tides');
      expect(inactive.status).toBe(ToolStatus.INACTIVE);

      // Foreign source's tool untouched.
      expect(savedTools.find((t: any) => t.id === 'tool-other_tool')).toBeUndefined();

      // Source bookkeeping updated.
      const savedSource = sourceRepository.save.mock.calls.at(-1)[0];
      expect(savedSource.toolCount).toBe(2);
      expect(savedSource.status).toBe(McpSourceStatus.ACTIVE);
      expect(savedSource.lastError).toBeNull();
      expect(savedSource.lastSyncAt).toBeInstanceOf(Date);
      expect(savedSource.serverInfo).toMatchObject({ name: 'fixture-server', protocolVersion: '2025-06-18' });
    });

    it('records status=error and lastError when discovery fails, then rethrows', async () => {
      sourceRepository.findOne.mockResolvedValue(baseSource());
      mcpClient.listTools.mockRejectedValue(
        new McpClientError('MCP_CONNECT_FAILED', 'Could not reach MCP server'),
      );

      await expect(service.sync('src-1', 'org-1')).rejects.toMatchObject({ code: 'MCP_CONNECT_FAILED' });

      const savedSource = sourceRepository.save.mock.calls.at(-1)[0];
      expect(savedSource.status).toBe(McpSourceStatus.ERROR);
      expect(savedSource.lastError).toContain('Could not reach');
    });

    it('404s for a source in another organization', async () => {
      sourceRepository.findOne.mockResolvedValue(null);
      await expect(service.sync('src-1', 'org-2')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes the source and every tool materialized from it', async () => {
      sourceRepository.findOne.mockResolvedValue(baseSource());
      const mine = [
        { id: 't1', type: ToolType.MCP, configuration: { mcp: { sourceId: 'src-1', remoteName: 'a' } } },
        { id: 't2', type: ToolType.MCP, configuration: { mcp: { sourceId: 'src-1', remoteName: 'b' } } },
      ];
      const foreign = { id: 't3', type: ToolType.MCP, configuration: { mcp: { sourceId: 'src-2', remoteName: 'c' } } };
      toolRepository.find.mockResolvedValue([...mine, foreign]);

      const result = await service.remove('src-1', 'org-1');

      expect(result.removedTools).toBe(2);
      expect(toolRepository.remove).toHaveBeenCalledWith(mine);
      expect(sourceRepository.remove).toHaveBeenCalled();
    });
  });

  describe('executeToolCall', () => {
    it('decrypts auth and sends the bearer header on tools/call', async () => {
      sourceRepository.findOne.mockResolvedValue({
        ...baseSource(),
        authType: 'bearer',
        authConfig: { bearerToken: encryptField('super-secret') },
      });
      mcpClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false });

      await service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'get_weather' }, { city: 'Berlin' });

      const [config, name, args] = mcpClient.callTool.mock.calls[0];
      expect(config.headers).toEqual({ Authorization: 'Bearer super-secret' });
      expect(name).toBe('get_weather');
      expect(args).toEqual({ city: 'Berlin' });
    });

    it('decrypts custom header auth', async () => {
      sourceRepository.findOne.mockResolvedValue({
        ...baseSource(),
        authType: 'headers',
        authConfig: { headers: { 'X-Api-Key': encryptField('k-123') } },
      });
      mcpClient.callTool.mockResolvedValue({ content: [], isError: false });

      await service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 't' }, {});

      expect(mcpClient.callTool.mock.calls[0][0].headers).toEqual({ 'X-Api-Key': 'k-123' });
    });

    it('fails with a typed error when the source is gone', async () => {
      sourceRepository.findOne.mockResolvedValue(null);
      await expect(
        service.executeToolCall('org-1', { sourceId: 'src-x', remoteName: 't' }, {}),
      ).rejects.toMatchObject({ name: 'McpClientError', code: 'MCP_CONNECT_FAILED' });
      expect(mcpClient.callTool).not.toHaveBeenCalled();
    });

    it('maps a remote isError result to success:false with the text as error', async () => {
      sourceRepository.findOne.mockResolvedValue(baseSource());
      mcpClient.callTool.mockResolvedValue({
        content: [{ type: 'text', text: 'city not found' }],
        isError: true,
      });

      const result = await service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 't' }, {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('city not found');
    });
  });

  describe('mapCallResult', () => {
    it('prefers structuredContent when present', () => {
      expect(
        service.mapCallResult({
          content: [{ type: 'text', text: 'ignored' }],
          structuredContent: { temp: 21 },
          isError: false,
        }),
      ).toEqual({ success: true, data: { temp: 21 } });
    });

    it('JSON-parses a single text block when possible', () => {
      expect(
        service.mapCallResult({ content: [{ type: 'text', text: '{"a":1}' }], isError: false }),
      ).toEqual({ success: true, data: { a: 1 } });
    });

    it('returns plain text unmodified when it is not JSON', () => {
      expect(
        service.mapCallResult({ content: [{ type: 'text', text: 'sunny, 21C' }], isError: false }),
      ).toEqual({ success: true, data: 'sunny, 21C' });
    });

    it('returns multi-block content as an array', () => {
      const content = [
        { type: 'text', text: 'part 1' },
        { type: 'image', data: 'base64...', mimeType: 'image/png' },
      ];
      expect(service.mapCallResult({ content, isError: false })).toEqual({ success: true, data: content });
    });
  });
});
