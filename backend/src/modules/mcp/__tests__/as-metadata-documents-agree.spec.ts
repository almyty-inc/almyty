import { McpOAuthDiscoveryController } from '../controllers/mcp-oauth-discovery.controller';
import { McpOAuthController } from '../controllers/mcp-oauth.controller';
import { GatewayStatus } from '../../../entities/gateway.entity';
import { snapshotEnv } from '../../../test/env';

/**
 * Authorization server metadata is served at two paths (RFC 8414's
 * path-inserted one and the path-suffixed one older MCP clients try). A
 * client must not get a different answer depending on which it asked: this
 * holds both controllers to the one builder, and pins the fields the
 * 2025-11-25 and 2026-07-28 authorization pages add.
 */
describe('both authorization server metadata documents agree', () => {
  const restore = snapshotEnv('MCP_CIMD_ENABLED');
  afterEach(restore);

  const base = 'https://api.example.com';
  const gateway: any = { id: 'gw-1', name: 'petstore', endpoint: '/petstore', organizationId: 'org-1', status: GatewayStatus.ACTIVE, configuration: {} };

  const discovery = () =>
    new McpOAuthDiscoveryController(
      { findOne: jest.fn().mockResolvedValue(gateway) } as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'org-1', slug: 'acme' }) } as any,
      { get: (key: string) => (key === 'BASE_URL' ? base : undefined) } as any,
    );
  const suffixed = () =>
    new McpOAuthController({} as any, {
      resolveOrgAndGateway: jest.fn().mockResolvedValue({ organization: { id: 'org-1' }, gateway }),
      getBaseUrl: () => base,
    } as any);

  it('serves the same document at both paths', async () => {
    const a = await discovery().authServerMetadata('acme', 'petstore');
    const b = await suffixed().getAuthorizationServerMetadata('acme', 'petstore');
    expect(a).toEqual(b);
  });

  it('advertises CIMD and the iss authorization response parameter, and keeps DCR', async () => {
    const doc: any = await discovery().authServerMetadata('acme', 'petstore');
    expect(doc.issuer).toBe(`${base}/acme/petstore`);
    expect(doc.client_id_metadata_document_supported).toBe(true);
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
    expect(doc.registration_endpoint).toBe(`${base}/acme/petstore/register`);
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('stops advertising CIMD when the server or the gateway turns it off', async () => {
    process.env.MCP_CIMD_ENABLED = 'false';
    expect(((await discovery().authServerMetadata('acme', 'petstore')) as any).client_id_metadata_document_supported).toBe(false);
    delete process.env.MCP_CIMD_ENABLED;

    gateway.configuration = { oauth: { clientMetadataDocuments: false } };
    try {
      const a: any = await discovery().authServerMetadata('acme', 'petstore');
      const b: any = await suffixed().getAuthorizationServerMetadata('acme', 'petstore');
      expect(a.client_id_metadata_document_supported).toBe(false);
      expect(b).toEqual(a);
    } finally {
      gateway.configuration = {};
    }
  });
});
