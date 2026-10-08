import { HttpException } from '@nestjs/common';

import { McpOAuthController } from '../controllers/mcp-oauth.controller';
import { McpOAuthService } from '../services/mcp-oauth.service';
import { fakeRepository } from '../../../test/fake-repository';
import { snapshotEnv } from '../../../test/env';

/**
 * application_type on Dynamic Client Registration (MCP 2026-07-28,
 * SEP-837): accepted, stored, echoed, and deciding the redirect rule.
 * DCR itself stays (deprecated in 2026-07-28, kept for clients without
 * Client ID Metadata Document support).
 */
describe('DCR application_type', () => {
  const restore = snapshotEnv('NODE_ENV', 'MCP_OAUTH_INFER_APPLICATION_TYPE');
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });
  afterEach(restore);

  function build() {
    const clients = fakeRepository<any>({ idPrefix: 'client' });
    const service = new McpOAuthService(clients as any, fakeRepository() as any, {} as any);
    const controller = new McpOAuthController(service, {
      resolveOrgAndGateway: jest.fn(async () => ({
        organization: { id: 'org-1' },
        gateway: { id: 'gw-1', name: 'gw', organizationId: 'org-1' },
      })),
    } as any);
    const res: any = {
      statusCode: 0,
      body: undefined,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.body = body; return this; },
    };
    const register = (body: any) => controller.register('org', 'gw', body, res);
    return { clients, res, register };
  }

  it('stores and echoes a native client with a private-use scheme', async () => {
    const { clients, res, register } = build();
    await register({ client_name: 'Cursor', application_type: 'native', redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] });
    expect(res.statusCode).toBe(201);
    expect(res.body.application_type).toBe('native');
    expect(clients.rows()[0].applicationType).toBe('native');
  });

  it('refuses a web client with a loopback redirect in production', async () => {
    const { clients, register } = build();
    await expect(
      register({ client_name: 'x', application_type: 'web', redirect_uris: ['http://127.0.0.1:3000/cb'] }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(clients.rows()).toHaveLength(0);
  });

  it('lets a web client use https', async () => {
    const { clients, res, register } = build();
    await register({ client_name: 'x', application_type: 'web', redirect_uris: ['https://app.example.com/cb'] });
    expect(res.body.application_type).toBe('web');
    expect(clients.rows()[0].applicationType).toBe('web');
  });

  it('refuses a private-use scheme for a web client', async () => {
    const { register } = build();
    await expect(register({ client_name: 'x', application_type: 'web', redirect_uris: ['cursor://x/cb'] })).rejects.toBeInstanceOf(HttpException);
  });

  it('refuses an unknown application_type', async () => {
    const { register } = build();
    await expect(register({ client_name: 'x', application_type: 'desktop', redirect_uris: ['https://a.example.com/cb'] })).rejects.toBeInstanceOf(HttpException);
  });

  // Clients that predate SEP-837 (most MCP CLIs and desktop apps) send no
  // type and loopback redirects; they keep signing in.
  it('takes an all-loopback registration without a type as native', async () => {
    const { clients, res, register } = build();
    await register({ client_name: 'claude-code', redirect_uris: ['http://localhost:54321/callback'] });
    expect(res.statusCode).toBe(201);
    expect(res.body.application_type).toBe('native');
    expect(clients.rows()[0].applicationType).toBe('native');
  });

  it('takes a registration without a type and with https redirects as web', async () => {
    const { res, register } = build();
    await register({ client_name: 'web app', redirect_uris: ['https://app.example.com/cb'] });
    expect(res.body.application_type).toBe('web');
  });

  it('applies the OIDC default (web) when MCP_OAUTH_INFER_APPLICATION_TYPE=false', async () => {
    process.env.MCP_OAUTH_INFER_APPLICATION_TYPE = 'false';
    const { register } = build();
    await expect(register({ client_name: 'x', redirect_uris: ['http://localhost:54321/callback'] })).rejects.toBeInstanceOf(HttpException);
  });
});
