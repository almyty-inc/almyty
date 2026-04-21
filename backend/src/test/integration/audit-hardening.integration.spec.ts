/**
 * Regression spec for the final audit-hardening pass.
 *
 * Each test pins a behavior that a bug introduced or a previous
 * commit fixed, so a future refactor can't silently regress any
 * of the findings from the 100% audit sweep. Grouped by module:
 *
 *   MonitoringController
 *     - /metrics refuses every request when PLATFORM_METRICS_TOKEN
 *       is unset (fail-closed default)
 *     - /metrics refuses a missing bearer header
 *     - /metrics refuses a wrong bearer token (constant-time)
 *     - /metrics/prometheus is behind the same gate
 *     - /health (public) returns ONLY {status}, no component detail
 *     - /stats/live returns no global metric fields (org-scoped only)
 *     - /enterprise/dashboard returns no global metric fields
 *
 *   FilesController
 *     - upload refuses disallowed MIME prefixes
 *
 *   TextExtractorService
 *     - extract truncates at EXTRACT_MAX_BYTES
 *
 *   OrganizationsService
 *     - getInviteDetails no longer returns `email` in the response
 *
 * These are unit-level tests that exercise the real code paths
 * with minimal stubs. They don't need real Postgres.
 */
jest.unmock('jsonwebtoken');

import * as crypto from 'crypto';
import { UnauthorizedException, HttpException } from '@nestjs/common';
import { MonitoringController } from '../../modules/monitoring/monitoring.controller';
import { FilesController } from '../../modules/files/files.controller';
import { TextExtractorService } from '../../modules/files/text-extractor.service';
import { OrganizationsService } from '../../modules/organizations/organizations.service';
import { UnifiedEndpointController } from '../../modules/gateways/unified-endpoint.controller';

// ─── MonitoringController platform-metrics token gate ─────────

describe('MonitoringController — platform metrics token gate', () => {
  const buildController = (svc: any) => new MonitoringController(svc);

  const svcStub = {
    getLatestMetrics: jest.fn().mockResolvedValue({ system: { uptime: 123 } }),
    getMetricsHistory: jest.fn().mockResolvedValue([]),
    getPrometheusMetrics: jest.fn().mockResolvedValue('# metrics'),
    getSystemHealth: jest.fn().mockResolvedValue({
      status: 'healthy',
      components: { database: { status: 'healthy' } },
      uptime: 123,
      version: '1.0.0',
    }),
    getActiveAlerts: jest.fn().mockResolvedValue([]),
  };

  beforeEach(() => {
    delete process.env.PLATFORM_METRICS_TOKEN;
    jest.clearAllMocks();
  });

  it('refuses /metrics when PLATFORM_METRICS_TOKEN is unset', async () => {
    const controller = buildController(svcStub);
    await expect(
      controller.getMetrics({ headers: { authorization: 'Bearer whatever' } } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuses /metrics when Authorization header is missing', async () => {
    process.env.PLATFORM_METRICS_TOKEN = 'the-real-token';
    const controller = buildController(svcStub);
    await expect(
      controller.getMetrics({ headers: {} } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuses /metrics when the bearer token does not match', async () => {
    process.env.PLATFORM_METRICS_TOKEN = 'the-real-token';
    const controller = buildController(svcStub);
    await expect(
      controller.getMetrics({ headers: { authorization: 'Bearer wrong-token' } } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('accepts /metrics with the exact bearer token', async () => {
    process.env.PLATFORM_METRICS_TOKEN = 'the-real-token';
    const controller = buildController(svcStub);
    const result = await controller.getMetrics({
      headers: { authorization: 'Bearer the-real-token' },
    } as any);
    expect(result.success).toBe(true);
    expect(svcStub.getLatestMetrics).toHaveBeenCalled();
  });

  it('refuses /metrics/history under the same gate', async () => {
    process.env.PLATFORM_METRICS_TOKEN = 'the-real-token';
    const controller = buildController(svcStub);
    await expect(
      controller.getMetricsHistory(1, { headers: {} } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuses /metrics/prometheus under the same gate', async () => {
    process.env.PLATFORM_METRICS_TOKEN = 'the-real-token';
    const controller = buildController(svcStub);
    await expect(
      controller.getPrometheusMetrics({ headers: { authorization: 'Bearer nope' } } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('/health (public) returns ONLY {status}, not component detail', async () => {
    const controller = buildController(svcStub);
    const result = await controller.getHealth();
    expect(Object.keys(result)).toEqual(['status']);
    expect(result.status).toBe('healthy');
    expect((result as any).components).toBeUndefined();
  });

  it('/stats/live returns no global metric fields (org-scoped only)', async () => {
    const controller = buildController(svcStub);
    const result = await controller.getLiveStats({
      user: { currentOrganizationId: 'org-1' },
    } as any);
    // No `.protocols`, `.performance`, `.security`, `.summary.totalRequests`
    // — the old shape leaked cross-tenant totals into every tenant's dashboard.
    const json = JSON.stringify(result.data);
    expect(json).not.toMatch(/totalRequests/);
    expect(json).not.toMatch(/activeTools/);
    expect(json).not.toMatch(/protocols/);
    expect(json).not.toMatch(/performance/);
    expect(json).not.toMatch(/piiFiltered/);
    // But the org-scoped alert count should be there.
    expect((result.data as any).summary.activeAlerts).toBeDefined();
  });

  it('/enterprise/dashboard no longer leaks global metric fields', async () => {
    const controller = buildController(svcStub);
    const result = await controller.getEnterpriseDashboard({
      user: { currentOrganizationId: 'org-1' },
    } as any);
    const json = JSON.stringify(result.data);
    expect(json).not.toMatch(/totalRequests/);
    expect(json).not.toMatch(/activeTools/);
    expect(json).not.toMatch(/instancesFiltered/);
    expect(json).not.toMatch(/threatsBlocked/);
    expect(json).not.toMatch(/currentResponseTime/);
    expect((result.data as any).alerts).toBeDefined();
  });
});

// ─── FilesController MIME allowlist ───────────────────────────

describe('FilesController — MIME allowlist', () => {
  const buildController = () => {
    const filesServiceStub = {
      upload: jest.fn().mockResolvedValue({ id: 'f-1', name: 'ok.txt' }),
    };
    const controller = new FilesController(filesServiceStub as any);
    return { controller, filesServiceStub };
  };

  const orgReq = { user: { currentOrganizationId: 'org-1', id: 'u-1' } } as any;

  it.each([
    ['application/x-msdownload', 'malware.exe'],
    ['text/html', 'stored-xss.html'],
    ['image/svg+xml', 'scriptable.svg'],
    ['application/java-archive', 'attack.jar'],
  ])('refuses upload with disallowed MIME %s', async (mime, name) => {
    const { controller, filesServiceStub } = buildController();
    await expect(
      controller.upload(
        { mimetype: mime, originalname: name, buffer: Buffer.from('x') } as any,
        'agent-1',
        'run-1',
        orgReq,
      ),
    ).rejects.toThrow(/mime/i);
    expect(filesServiceStub.upload).not.toHaveBeenCalled();
  });

  it.each([
    ['image/png', 'photo.png'],
    ['application/pdf', 'doc.pdf'],
    ['text/plain', 'notes.txt'],
    ['application/json', 'data.json'],
  ])('accepts upload with allowed MIME %s', async (mime, name) => {
    const { controller, filesServiceStub } = buildController();
    const result = await controller.upload(
      { mimetype: mime, originalname: name, buffer: Buffer.from('x') } as any,
      'agent-1',
      'run-1',
      orgReq,
    );
    expect(result.success).toBe(true);
    expect(filesServiceStub.upload).toHaveBeenCalled();
  });
});

// ─── TextExtractorService truncation cap ──────────────────────

describe('TextExtractorService — extraction cap', () => {
  const service = new TextExtractorService();

  it('returns the full content when under the cap', async () => {
    const content = 'hello world';
    const out = await service.extract(Buffer.from(content), 'text/plain', 'small.txt');
    expect(out).toBe(content);
  });

  it('truncates with a marker when over the cap', async () => {
    // 2 MB buffer — 1 MB over the 1 MB cap.
    const big = Buffer.alloc(2 * 1024 * 1024, 'a');
    const out = await service.extract(big, 'text/plain', 'huge.txt');
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(big.length);
    expect(out!.length).toBeLessThan(1 * 1024 * 1024 + 200);
    expect(out).toMatch(/truncated/);
  });

  it('returns null for non-text MIME types', async () => {
    const out = await service.extract(Buffer.from([0, 1, 2]), 'application/pdf', 'bin.pdf');
    expect(out).toBeNull();
  });
});

// ─── OrganizationsService.getInviteDetails email stripping ────

describe('OrganizationsService.getInviteDetails — email privacy', () => {
  it('does not return the email field to unauthenticated callers', async () => {
    // Build the service with stub repositories. We only exercise the
    // response shape; the JSONB lookup is unit-tested separately.
    const membershipRepo = {
      findOne: jest.fn().mockResolvedValue({
        role: 'member',
        inviteExpiresAt: new Date(Date.now() + 86_400_000),
        organization: { name: 'Acme' },
      }),
    };
    const orgRepo = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
    };
    const service = new OrganizationsService(
      orgRepo as any,
      membershipRepo as any,
      { findOne: jest.fn() } as any, // Team
      { findOne: jest.fn() } as any, // UserTeam
      { findOne: jest.fn() } as any, // User
      { sendInvitation: jest.fn() } as any, // MailService
      { ensureSystemGateway: jest.fn() } as any, // GatewaysService
    );

    const result = await service.getInviteDetails('valid-token');
    expect(result).toEqual({
      organizationName: 'Acme',
      role: 'member',
      isExpired: false,
    });
    expect((result as any).email).toBeUndefined();
  });
});

// ─── UnifiedEndpointController agent API-key gate ─────────────

describe('UnifiedEndpointController — agent path API key gate', () => {
  // The unified endpoint used to let ANY anonymous caller execute
  // any agent via POST /:orgSlug/:agentSlug/invoke. Every path that
  // touches `handleAgentRequest` must now first resolve a real
  // api_key row scoped to the agent's own org. The test exercises
  // that gate at the controller level with mocked repositories so
  // we don't need a full Nest app.

  function buildController(apiKeyRow?: any) {
    const orgRepo: any = { findOne: jest.fn() };
    const gatewayRepo: any = { findOne: jest.fn().mockResolvedValue(null) };
    const agentRepo: any = {
      findOne: jest.fn().mockResolvedValue({
        id: 'agent-1',
        name: 'my-agent',
        organizationId: 'org-1',
        status: 'active',
      }),
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      }),
    };
    const apiKeyRepo: any = {
      findOne: jest.fn().mockResolvedValue(apiKeyRow ?? null),
    };
    const mcpServiceStub: any = {};

    const utcpServiceStub: any = {};
    const gatewayResolverStub: any = {
      resolveOrganization: jest.fn().mockResolvedValue({
        id: 'org-1',
        name: 'Org One',
        slug: 'org-one',
      }),
    };
    const agentsServiceStub: any = {};
    const executionEngineStub: any = {
      execute: jest.fn().mockResolvedValue({
        id: 'exec-1',
        status: 'completed',
      }),
    };

    const a2aServerStub: any = { handleJsonRpc: jest.fn() };
    const a2aAgentCardStub: any = { buildAgentCard: jest.fn() };

    const almytyMcpStub: any = { handleJsonRpc: jest.fn() };
    const acpServerStub: any = { handleJsonRpc: jest.fn() };
    const acpDiscoveryStub: any = { buildDiscovery: jest.fn() };

    const mcpOAuthStub: any = { validateAccessToken: jest.fn() };

    return new UnifiedEndpointController(
      orgRepo,
      gatewayRepo,
      agentRepo,
      apiKeyRepo,
      mcpServiceStub,
      almytyMcpStub,
      mcpOAuthStub,
      utcpServiceStub,
      gatewayResolverStub,
      agentsServiceStub,
      executionEngineStub,
      a2aServerStub,
      a2aAgentCardStub,
      acpServerStub,
      acpDiscoveryStub,
      { startRun: jest.fn(), getRun: jest.fn(), listRuns: jest.fn(), getRunEmitter: jest.fn(), sendInput: jest.fn(), cancelRun: jest.fn() } as any,
    );
  }

  const req = (headers: Record<string, string> = {}, method = 'POST', path = '/org-one/my-agent/invoke') =>
    ({ path, method, headers } as any);
  const res = () => {
    const r: any = {};
    r.json = jest.fn().mockReturnValue(r);
    r.status = jest.fn().mockReturnValue(r);
    r.setHeader = jest.fn();
    r.flushHeaders = jest.fn();
    r.write = jest.fn();
    r.end = jest.fn();
    return r;
  };

  it('refuses POST /:org/:agent/invoke with no Authorization header', async () => {
    const controller = buildController();
    await expect(
      controller.handleSubPathRequest('org-one', 'my-agent', req({}), res(), {}),
    ).rejects.toThrow(HttpException);
  });

  it('refuses POST /:org/:agent/invoke with a non-Bearer Authorization header', async () => {
    const controller = buildController();
    await expect(
      controller.handleSubPathRequest(
        'org-one',
        'my-agent',
        req({ authorization: 'Basic foo' }),
        res(),
        {},
      ),
    ).rejects.toThrow(HttpException);
  });

  it('refuses POST /:org/:agent/invoke when the API key hash does not match', async () => {
    // apiKeyRepo returns null — simulates a missing or cross-org key.
    const controller = buildController(null);
    await expect(
      controller.handleSubPathRequest(
        'org-one',
        'my-agent',
        req({ authorization: 'Bearer attacker-guessed-key' }),
        res(),
        {},
      ),
    ).rejects.toThrow(HttpException);
  });

  it('refuses POST /:org/:agent/invoke when the API key is expired', async () => {
    const apiKeyRow = {
      id: 'key-1',
      userId: 'u-1',
      organizationId: 'org-1',
      isActive: true,
      expiresAt: new Date(Date.now() - 86_400_000),
    };
    const controller = buildController(apiKeyRow);
    const rawKey = 'valid-but-expired';
    await expect(
      controller.handleSubPathRequest(
        'org-one',
        'my-agent',
        req({ authorization: `Bearer ${rawKey}` }),
        res(),
        {},
      ),
    ).rejects.toThrow(HttpException);
  });

  it('accepts POST /:org/:agent/invoke with a valid in-org API key', async () => {
    const rawKey = 'valid-in-org-api-key';
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const apiKeyRow = {
      id: 'key-1',
      userId: 'u-1',
      organizationId: 'org-1',
      keyHash,
      isActive: true,
      expiresAt: null,
    };
    const controller = buildController(apiKeyRow);
    const r = res();
    await controller.handleSubPathRequest(
      'org-one',
      'my-agent',
      req({ authorization: `Bearer ${rawKey}` }),
      r,
      {},
    );
    expect(r.json).toHaveBeenCalled();
  });
});
