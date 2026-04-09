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

import { UnauthorizedException } from '@nestjs/common';
import { MonitoringController } from '../../modules/monitoring/monitoring.controller';
import { FilesController } from '../../modules/files/files.controller';
import { TextExtractorService } from '../../modules/files/text-extractor.service';
import { OrganizationsService } from '../../modules/organizations/organizations.service';

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
