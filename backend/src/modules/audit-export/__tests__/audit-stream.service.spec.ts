import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditStreamService } from '../audit-stream.service';
import { AuditStreamConfig } from '../../../entities/audit-stream-config.entity';

class FakeConfigRepo {
  rows: AuditStreamConfig[] = [];
  private idc = 0;
  create(partial: any) {
    return { id: `c_${++this.idc}`, createdAt: new Date(), updatedAt: new Date(), ...partial } as AuditStreamConfig;
  }
  async save(row: AuditStreamConfig) {
    const i = this.rows.findIndex((r) => r.id === row.id);
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
    return row;
  }
  async findOne({ where }: any) {
    return this.rows.find((r) => Object.entries(where).every(([k, v]) => (r as any)[k] === v)) ?? null;
  }
  async find({ where }: any = {}) {
    return this.rows.filter((r) => Object.entries(where ?? {}).every(([k, v]) => (r as any)[k] === v));
  }
  async remove(row: AuditStreamConfig) {
    this.rows = this.rows.filter((r) => r.id !== row.id);
    return row;
  }
}

function makeService() {
  const repo = new FakeConfigRepo();
  const svc = new AuditStreamService(repo as any);
  return { svc, repo };
}

describe('AuditStreamService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  describe('config CRUD', () => {
    it('creates + validates a config', async () => {
      const { svc } = makeService();
      const cfg = await svc.create({
        organizationId: 'org',
        target: 'webhook',
        endpoint: 'https://hooks.example.com/audit',
        token: 'secret',
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.endpoint).toBe('https://hooks.example.com/audit');
    });

    it('rejects an unsupported target', async () => {
      const { svc } = makeService();
      await expect(
        svc.create({ organizationId: 'org', target: 'kafka' as any, endpoint: 'x' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a missing endpoint', async () => {
      const { svc } = makeService();
      await expect(
        svc.create({ organizationId: 'org', target: 'webhook', endpoint: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('remove is org-scoped', async () => {
      const { svc } = makeService();
      const cfg = await svc.create({ organizationId: 'org-a', target: 'webhook', endpoint: 'https://x' });
      await expect(svc.remove('org-b', cfg.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('buildRequest (per-target payload)', () => {
    it('formats a Splunk HEC request', () => {
      const { svc } = makeService();
      const cfg = { target: 'splunk_hec', endpoint: 'https://splunk/services/collector', token: 'hec-tok' } as AuditStreamConfig;
      const req = svc.buildRequest(cfg, { action: 'create' as any, organizationId: 'org' });
      expect(req.headers.Authorization).toBe('Splunk hec-tok');
      expect(JSON.parse(req.body).sourcetype).toBe('almyty:audit');
    });

    it('formats a Datadog request', () => {
      const { svc } = makeService();
      const cfg = { target: 'datadog', endpoint: 'https://http-intake.logs.datadoghq.com', token: 'dd-key' } as AuditStreamConfig;
      const req = svc.buildRequest(cfg, { action: 'delete' as any, organizationId: 'org' });
      expect(req.headers['DD-API-KEY']).toBe('dd-key');
      const arr = JSON.parse(req.body);
      expect(arr[0].ddsource).toBe('almyty');
      expect(arr[0].ddtags).toContain('action:delete');
    });

    it('formats a generic webhook with bearer', () => {
      const { svc } = makeService();
      const cfg = { target: 'webhook', endpoint: 'https://hooks/x', token: 'bt' } as AuditStreamConfig;
      const req = svc.buildRequest(cfg, { action: 'update' as any });
      expect(req.headers.Authorization).toBe('Bearer bt');
      expect(JSON.parse(req.body).type).toBe('audit.event');
    });
  });

  describe('dispatch (mocked fetch)', () => {
    it('POSTs to each enabled target and records success', async () => {
      const { svc, repo } = makeService();
      await svc.create({ organizationId: 'org', target: 'webhook', endpoint: 'https://a' });
      await svc.create({ organizationId: 'org', target: 'datadog', endpoint: 'https://b', token: 'k' });
      const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
      global.fetch = fetchMock as any;

      const results = await svc.dispatch({ organizationId: 'org', action: 'create' as any });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(repo.rows.every((c) => c.lastDeliveredAt != null)).toBe(true);
    });

    it('honors the per-config actionFilter', async () => {
      const { svc } = makeService();
      await svc.create({
        organizationId: 'org',
        target: 'webhook',
        endpoint: 'https://a',
        actionFilter: ['delete'],
      });
      const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
      global.fetch = fetchMock as any;

      const results = await svc.dispatch({ organizationId: 'org', action: 'create' as any });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(results).toHaveLength(0);
    });

    it('records the error and never throws when a target fails', async () => {
      const { svc, repo } = makeService();
      await svc.create({ organizationId: 'org', target: 'webhook', endpoint: 'https://a' });
      global.fetch = jest.fn().mockRejectedValue(new Error('connreset')) as any;

      const results = await svc.dispatch({ organizationId: 'org', action: 'create' as any });
      expect(results[0].ok).toBe(false);
      expect(results[0].error).toBe('connreset');
      expect(repo.rows[0].lastError).toBe('connreset');
    });

    it('marks non-2xx responses as failed', async () => {
      const { svc, repo } = makeService();
      await svc.create({ organizationId: 'org', target: 'webhook', endpoint: 'https://a' });
      global.fetch = jest.fn().mockResolvedValue({ status: 503 }) as any;

      const results = await svc.dispatch({ organizationId: 'org', action: 'create' as any });
      expect(results[0].ok).toBe(false);
      expect(results[0].status).toBe(503);
      expect(repo.rows[0].lastError).toBe('HTTP 503');
    });
  });
});
