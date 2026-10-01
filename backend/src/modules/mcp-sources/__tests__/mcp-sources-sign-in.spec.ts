import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { McpSourcesService } from '../mcp-sources.service';
import { McpClientService, McpClientError } from '../mcp-client.service';
import { McpSource, McpSourceStatus } from '../../../entities/mcp-source.entity';
import { Tool } from '../../../entities/tool.entity';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { encryptField } from '../../../common/security/field-crypto';
import { CredentialType } from '../../../entities/credential.entity';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { FakeCredentialStore, makeCredentialRefFake } from '../../../test/credential-ref.fake';
import { unlimitedToolQuotaManager } from '../../../test/tool-quota.fake';
import { McpOAuthClientService } from '../../connections/mcp-oauth/mcp-oauth-client.service';

/**
 * An MCP source on a server you signed in to (connections/mcp-oauth): the
 * sign-in is renewed before it expires, a 401 renews it and retries once,
 * and a sign-in that cannot be renewed says to sign in again instead of
 * sending a token that will not work.
 */
describe('MCP sources on a signed-in server', () => {
  let service: McpSourcesService;
  let sourceRepository: any;
  let mcpClient: any;
  let oauth: { ensureFresh: jest.Mock };
  let store: FakeCredentialStore;
  let credentialId: string;

  const source = (): McpSource =>
    ({
      id: 'src-1',
      name: 'docs',
      url: 'https://mcp.example.com/mcp',
      authType: 'bearer',
      authConfig: null,
      status: McpSourceStatus.ACTIVE,
      organizationId: 'org-1',
      credentialId,
    }) as unknown as McpSource;

  const unauthorized = () => new McpClientError('MCP_HTTP_ERROR', 'MCP server returned HTTP 401 for tools/call', { status: 401, body: '' });

  beforeEach(async () => {
    sourceRepository = { findOne: jest.fn(async () => source()), save: jest.fn(async (x: any) => x) };
    mcpClient = {
      assertUrlAllowed: jest.fn(),
      listTools: jest.fn(),
      callTool: jest.fn(),
      // The service calls callToolOutcome (the dual-era client); a plain
      // result here comes from the callTool mock, so the cases below keep
      // asserting on what it was sent.
      callToolOutcome: jest.fn(async (config: any, name: string, args: any) => ({
        outcome: { kind: 'result', result: await mcpClient.callTool(config, name, args) },
        init: { era: 'legacy', protocolVersion: '2025-11-25', serverInfo: {}, sessionId: null, capabilities: {} },
      })),
      cancelTask: jest.fn(),
    };
    store = makeCredentialRefFake();
    const row = store.seed({
      organizationId: 'org-1',
      type: CredentialType.OAUTH2,
      connectorKey: 'mcp-custom',
      config: { accessToken: encryptField('at-1'), tokenType: 'Bearer', oauthIssuer: 'https://auth.example.com' },
    });
    credentialId = row.id;
    oauth = { ensureFresh: jest.fn(async () => ({ status: 'fresh' })) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpSourcesService,
        { provide: EnvelopeCryptoService, useValue: makeEnvelopeCryptoMock() },
        { provide: getRepositoryToken(McpSource), useValue: sourceRepository },
        { provide: getRepositoryToken(Tool), useValue: { get manager() { return unlimitedToolQuotaManager(this); }, find: jest.fn().mockResolvedValue([]) } },
        { provide: McpClientService, useValue: mcpClient },
        { provide: CredentialRefResolver, useValue: store.resolver },
        { provide: McpOAuthClientService, useValue: oauth },
      ],
    }).compile();
    service = module.get(McpSourcesService);
  });

  /** The issuer hands out a new token: what a refresh leaves in the row. */
  const renewTo = (token: string) => async () => {
    store.rows.find((r) => r.id === credentialId)!.config = { accessToken: encryptField(token), tokenType: 'Bearer', oauthIssuer: 'https://auth.example.com' };
    return { status: 'refreshed' };
  };

  it('makes sure the sign-in is fresh before a call, and sends its token', async () => {
    mcpClient.callTool.mockResolvedValue({ content: [], isError: false });
    await service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'search' }, {});
    expect(oauth.ensureFresh).toHaveBeenCalledWith('org-1', credentialId);
    expect(mcpClient.callTool.mock.calls[0][0].headers).toEqual({ Authorization: 'Bearer at-1' });
  });

  it('renews the sign-in on a 401 and retries once with the new token', async () => {
    mcpClient.callTool.mockRejectedValueOnce(unauthorized()).mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], isError: false });
    oauth.ensureFresh.mockImplementation(async (_org: string, _id: string, opts?: { force?: boolean }) => (opts?.force ? renewTo('at-2')() : { status: 'fresh' }));

    const result = await service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'search' }, {});
    expect(result.success).toBe(true);
    expect(oauth.ensureFresh).toHaveBeenCalledWith('org-1', credentialId, { force: true });
    expect(mcpClient.callTool).toHaveBeenCalledTimes(2);
    expect(mcpClient.callTool.mock.calls[1][0].headers).toEqual({ Authorization: 'Bearer at-2' });
  });

  it('says to sign in again when the 401 cannot be fixed, and does not retry', async () => {
    mcpClient.callTool.mockRejectedValue(unauthorized());
    oauth.ensureFresh.mockImplementation(async (_o: string, _i: string, opts?: { force?: boolean }) =>
      opts?.force ? { status: 'reconnect', error: 'mcp.example.com now signs in with new-auth.example.com instead of auth.example.com. Sign in again.' } : { status: 'fresh' },
    );
    await expect(service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'search' }, {})).rejects.toThrow(/Sign in again/);
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not call at all with a sign-in that has run out and cannot be renewed', async () => {
    oauth.ensureFresh.mockResolvedValue({ status: 'reconnect', error: 'The sign-in to mcp.example.com has expired. Sign in again.' });
    await expect(service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'search' }, {})).rejects.toThrow(/has expired/);
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });

  it('leaves a 401 from a server that is not signed in to as it is', async () => {
    mcpClient.callTool.mockRejectedValue(unauthorized());
    oauth.ensureFresh.mockResolvedValue({ status: 'not_mcp_oauth' });
    await expect(service.executeToolCall('org-1', { sourceId: 'src-1', remoteName: 'search' }, {})).rejects.toThrow(/HTTP 401/);
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
  });

  it('renews on a 401 during a sync too', async () => {
    sourceRepository.findOne.mockResolvedValue(source());
    mcpClient.listTools.mockRejectedValueOnce(unauthorized()).mockResolvedValueOnce({ tools: [], init: { protocolVersion: '2025-06-18', serverInfo: { name: 'Docs', version: '1' }, sessionId: null, capabilities: {} } });
    oauth.ensureFresh.mockImplementation(async (_org: string, _id: string, opts?: { force?: boolean }) => (opts?.force ? renewTo('at-3')() : { status: 'fresh' }));
    await service.sync('src-1', 'org-1');
    expect(mcpClient.listTools).toHaveBeenCalledTimes(2);
    expect(mcpClient.listTools.mock.calls[1][0].headers).toEqual({ Authorization: 'Bearer at-3' });
  });
});
