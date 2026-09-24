import { HttpException } from '@nestjs/common';

import { McpOAuthController } from '../controllers/mcp-oauth.controller';
import { McpOAuthService } from '../services/mcp-oauth.service';
import { validateRedirectUri } from '../services/mcp-oauth-helpers.helper';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * A redirect_uri is where the consent page sends the browser, from the
 * dashboard's own origin. The policy was "https, or anything whose host
 * is localhost" -- and `javascript://localhost/%0aalert(1)//` has host
 * localhost. The consent page builds the redirect with `new URL(...)`
 * and assigns it to `window.location.href`, so a client registered with
 * that URI ran its script in the dashboard origin as soon as the victim
 * clicked Approve or Deny. Only http(s) may be a redirect target.
 */
describe('MCP OAuth redirect_uri scheme', () => {
  const hostile = [
    'javascript://localhost/%0aalert(document.domain)//',
    'javascript://127.0.0.1/%0afetch(1)//',
    'data://localhost/text/html,hi',
    'file://localhost/etc/passwd',
    'vbscript://localhost/x',
  ];
  const fine = [
    'https://client.example.com/callback',
    'http://localhost:3000/callback',
    'http://127.0.0.1:8080/cb',
    'http://[::1]:8080/cb',
  ];

  it.each(hostile)('the policy refuses %s', (uri) => {
    expect(() => validateRedirectUri(uri)).toThrow();
  });

  it.each(fine)('the policy accepts %s', (uri) => {
    expect(() => validateRedirectUri(uri)).not.toThrow();
  });

  function buildController() {
    const clients = fakeRepository<any>({ idPrefix: 'client' });
    const service = new McpOAuthService(clients as any, fakeRepository() as any, {} as any);
    const resolve = {
      resolveOrgAndGateway: jest.fn(async () => ({
        organization: { id: 'org-1' },
        gateway: { id: 'gw-1', name: 'gw', organizationId: 'org-1' },
      })),
    };
    const controller = new McpOAuthController(service, resolve as any);
    const res: any = {
      statusCode: 0,
      body: undefined,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.body = body; return this; },
    };
    return { controller, clients, res };
  }

  it.each(hostile)('dynamic registration refuses %s and stores nothing', async (uri) => {
    const { controller, clients, res } = buildController();
    await expect(
      controller.register('org', 'gw', { client_name: 'x', redirect_uris: [uri] }, res),
    ).rejects.toBeInstanceOf(HttpException);
    expect(clients.rows()).toHaveLength(0);
  });

  it('dynamic registration still accepts a loopback http client', async () => {
    const { controller, clients, res } = buildController();
    await controller.register('org', 'gw', { client_name: 'cli', redirect_uris: ['http://[::1]:33418/cb'] }, res);
    expect(res.statusCode).toBe(201);
    expect(clients.rows()).toHaveLength(1);
  });
});
