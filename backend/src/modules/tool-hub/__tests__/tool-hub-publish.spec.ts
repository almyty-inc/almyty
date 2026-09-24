import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { FindOperator } from 'typeorm';

import { ToolHubService } from '../tool-hub.service';
import { ToolExecutionMethod, ToolStatus } from '../../../entities/tool.entity';
import { seedPublicToolTemplates } from '../public-templates.seed';
import { unlimitedToolQuotaManager } from '../../../test/tool-quota.fake';

/**
 * Publishing is the tool hub's only authoring path, so these tests carry
 * the two rules that make it safe -- a write never escapes the caller's
 * organization, and a template never carries a credential -- plus the
 * round trip that is the whole point: publish a tool, read it back from
 * the hub, install it, get a tool that can execute.
 */

/** Minimal in-memory stand-in so a real publish -> install can be driven. */
class FakeRepo<T extends Record<string, any>> {
  rows: T[] = [];
  private seq = 0;

  constructor(private readonly prefix: string) {}

  create(input: any): any {
    return { ...input };
  }

  async save(row: any): Promise<any> {
    if (!row.id) {
      row.id = `${this.prefix}-${++this.seq}`;
      this.rows.push(row);
      return row;
    }
    const index = this.rows.findIndex((r) => r.id === row.id);
    if (index >= 0) this.rows[index] = { ...this.rows[index], ...row };
    else this.rows.push(row);
    return this.rows.find((r) => r.id === row.id);
  }

  async remove(row: any): Promise<any> {
    this.rows = this.rows.filter((r) => r.id !== row.id);
    return row;
  }

  async find({ where }: any): Promise<any[]> {
    return this.rows.filter((row) => this.matches(row, where));
  }

  async findOne({ where }: any): Promise<any> {
    return this.rows.find((row) => this.matches(row, where)) ?? null;
  }

  async increment(where: any, field: string, by: number): Promise<void> {
    const row = this.rows.find((r) => this.matches(r, where));
    if (row) (row as any)[field] = ((row as any)[field] ?? 0) + by;
  }

  private matches(row: any, where: Record<string, any>): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (expected instanceof FindOperator && expected.type === 'isNull') {
        return row[key] === null || row[key] === undefined;
      }
      return row[key] === expected;
    });
  }
}

function makeService() {
  const templateRepository = new FakeRepo<any>('tpl');
  const toolRepository = new FakeRepo<any>('tool');
  (toolRepository as any).manager = unlimitedToolQuotaManager();
  const apiRepository = new FakeRepo<any>('api');
  const auditLogService = { logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn() };

  const service = new ToolHubService(
    templateRepository as any,
    toolRepository as any,
    apiRepository as any,
    auditLogService as any,
  );

  return { service, templateRepository, toolRepository, apiRepository, auditLogService };
}

/** A working HTTP tool, with credentials in every place one can hide. */
function seedTool(toolRepository: FakeRepo<any>, overrides: Record<string, any> = {}) {
  const api = {
    id: 'api-src',
    name: 'Acme API',
    baseUrl: 'https://api.acme.test',
    organizationId: 'org-a',
    headers: { Authorization: 'Bearer live-org-a-token', Accept: 'application/json' },
    authentication: { type: 'bearer', config: { token: 'live-org-a-token' } },
  };
  const tool = {
    id: 'tool-1',
    name: 'List widgets',
    description: 'List every widget',
    organizationId: 'org-a',
    executionMethod: ToolExecutionMethod.HTTP,
    status: ToolStatus.ACTIVE,
    version: '2.1.0',
    apiId: 'api-src',
    api,
    authConfig: { type: 'bearer', config: { token: 'live-org-a-token' } },
    httpConfig: {
      method: 'GET',
      path: '/v1/widgets',
      headers: { Authorization: 'Bearer live-org-a-token', Accept: 'application/json' },
      queryParams: { limit: '{limit}', api_key: 'live-org-a-key-value-1234' },
      responseMapping: { dataPath: 'data' },
    },
    parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
    configuration: { timeout: 5000, mcp: { sourceId: 'src-1', remoteName: 'x' } },
    examples: [{ name: 'first page', input: { limit: 10, api_key: 'live-org-a-key-value-1234' } }],
    metadata: { credentialId: 'cred-org-a', sourceApi: { name: 'Acme API' } },
    ...overrides,
  };
  toolRepository.rows.push(tool);
  return tool;
}

describe('ToolHubService publishing', () => {
  // ── tenancy ──────────────────────────────────────────────────────

  it('stamps the caller organization on the template and never a null', async () => {
    const { service, toolRepository } = makeService();
    seedTool(toolRepository);

    const template = await service.publishTool('org-a', 'user-a', {
      toolId: 'tool-1',
      category: 'commerce',
    });

    expect(template.organizationId).toBe('org-a');
    expect(template.createdBy).toBe('user-a');
    expect(template.sourceToolId).toBe('tool-1');
  });

  it('refuses to publish another organization tool', async () => {
    const { service, toolRepository, templateRepository } = makeService();
    seedTool(toolRepository);

    await expect(
      service.publishTool('org-b', 'user-b', { toolId: 'tool-1', category: 'commerce' }),
    ).rejects.toThrow(NotFoundException);
    expect(templateRepository.rows).toHaveLength(0);
  });

  it('refuses to edit a template owned by another organization', async () => {
    const { service, toolRepository } = makeService();
    seedTool(toolRepository);
    const template = await service.publishTool('org-a', 'user-a', {
      toolId: 'tool-1',
      category: 'commerce',
    });

    await expect(
      service.updateTemplate(template.id, 'org-b', 'user-b', { description: 'mine now' }),
    ).rejects.toThrow(NotFoundException);
    await expect(service.deleteTemplate(template.id, 'org-b', 'user-b')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuses to edit or retract a public template', async () => {
    const { service, templateRepository } = makeService();
    templateRepository.rows.push({
      id: 'tpl-public',
      name: 'Public thing',
      organizationId: null,
    });

    // A public template is readable by org-a, but not writable by it --
    // otherwise one tenant could rewrite what every tenant installs.
    await expect(service.getTemplate('tpl-public', 'org-a')).resolves.toMatchObject({
      id: 'tpl-public',
    });
    await expect(
      service.updateTemplate('tpl-public', 'org-a', 'user-a', { description: 'hijacked' }),
    ).rejects.toThrow(NotFoundException);
    await expect(service.deleteTemplate('tpl-public', 'org-a', 'user-a')).rejects.toThrow(
      NotFoundException,
    );
    expect(templateRepository.rows).toHaveLength(1);
  });

  it('refuses a second template with the same name in one organization', async () => {
    const { service, toolRepository } = makeService();
    seedTool(toolRepository);
    await service.publishTool('org-a', 'user-a', { toolId: 'tool-1', category: 'commerce' });

    await expect(
      service.publishTool('org-a', 'user-a', { toolId: 'tool-1', category: 'commerce' }),
    ).rejects.toThrow(ConflictException);
  });

  // ── secrets ──────────────────────────────────────────────────────

  it('carries no credential from the tool, its config or its API', async () => {
    const { service, toolRepository } = makeService();
    seedTool(toolRepository);

    const template = await service.publishTool('org-a', 'user-a', {
      toolId: 'tool-1',
      category: 'commerce',
    });

    const serialized = JSON.stringify(template);
    expect(serialized).not.toContain('live-org-a-token');
    expect(serialized).not.toContain('live-org-a-key-value-1234');
    expect(serialized).not.toContain('cred-org-a');

    expect(template.httpConfig).not.toHaveProperty('headers');
    expect(template.httpConfig.queryParams).toEqual({ limit: '{limit}' });
    expect(template).not.toHaveProperty('authConfig');
    expect(template).not.toHaveProperty('metadata');
    expect(template.configuration).toEqual({ timeout: 5000 });
    expect(template.examples).toEqual([{ name: 'first page', input: { limit: 10 } }]);
  });

  it('publishes the API shape and the kind of auth it needs, never the auth itself', async () => {
    const { service, toolRepository } = makeService();
    seedTool(toolRepository);

    const template = await service.publishTool('org-a', 'user-a', {
      toolId: 'tool-1',
      category: 'commerce',
    });

    expect(template.apiConfig).toEqual({
      name: 'Acme API',
      baseUrl: 'https://api.acme.test',
      authRequirements: { type: 'bearer' },
    });
    expect(template.apiConfig).not.toHaveProperty('headers');
  });

  // ── what a template can carry ────────────────────────────────────

  it('refuses a tool whose execution method a template cannot carry', async () => {
    const { service, toolRepository } = makeService();
    seedTool(toolRepository, {
      executionMethod: ToolExecutionMethod.GRAPHQL,
      httpConfig: null,
    });

    await expect(
      service.publishTool('org-a', 'user-a', { toolId: 'tool-1', category: 'commerce' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses an http tool with no request to publish', async () => {
    const { service, toolRepository } = makeService();
    seedTool(toolRepository, { httpConfig: null });

    await expect(
      service.publishTool('org-a', 'user-a', { toolId: 'tool-1', category: 'commerce' }),
    ).rejects.toThrow(BadRequestException);
  });

  // ── the round trip ───────────────────────────────────────────────

  it('publishes, reads back from the hub and installs into a working tool', async () => {
    const { service, toolRepository, apiRepository } = makeService();
    seedTool(toolRepository);

    const published = await service.publishTool('org-a', 'user-a', {
      toolId: 'tool-1',
      category: 'commerce',
      tags: ['widgets'],
    });

    // Visible in the publishing organization's hub...
    await expect(service.getTemplate(published.id, 'org-a')).resolves.toMatchObject({
      id: published.id,
      provider: 'Acme API',
    });
    // ...and in nobody else's.
    await expect(service.getTemplate(published.id, 'org-b')).rejects.toThrow(NotFoundException);

    const { tool, api } = await service.installTemplate(published.id, 'org-a', 'user-a');

    expect(tool.organizationId).toBe('org-a');
    expect(tool.status).toBe(ToolStatus.ACTIVE);
    expect(tool.executionMethod).toBe(ToolExecutionMethod.HTTP);
    expect(tool.httpConfig).toMatchObject({ method: 'GET', path: '/v1/widgets' });
    expect(tool.parameters).toEqual(published.parameters);
    expect(api?.baseUrl).toBe('https://api.acme.test');
    // The installing organization gets an Api with no inherited credential.
    expect(apiRepository.rows.find((r) => r.id === api?.id)?.headers).toEqual({});
    expect(JSON.stringify(tool)).not.toContain('live-org-a-token');
  });

  it('never turns a template header into a live default header on the installing org API', async () => {
    // The publish path never writes apiConfig.headers, but a template is
    // data -- an operator-seeded row, or one restored from a backup --
    // and install is the point where one becomes a real header on a real
    // Api inside the installing organization.
    const { service, templateRepository, apiRepository } = makeService();
    templateRepository.rows.push({
      id: 'tpl-headers',
      name: 'Hand written',
      organizationId: null,
      provider: 'Acme',
      category: 'commerce',
      executionMethod: ToolExecutionMethod.HTTP,
      httpConfig: { method: 'GET', path: '/v1/widgets' },
      parameters: {},
      configuration: {},
      examples: [],
      apiConfig: {
        name: 'Acme API',
        baseUrl: 'https://api.acme.test',
        headers: { Accept: 'application/json', Authorization: 'Bearer smuggled-token' },
      },
      installCount: 0,
    });

    const { api } = await service.installTemplate('tpl-headers', 'org-z', 'user-z');

    const created = apiRepository.rows.find((r) => r.id === api?.id);
    expect(created?.headers).toEqual({ Accept: 'application/json' });
    expect(JSON.stringify(created)).not.toContain('smuggled-token');
  });

  it('installs a public template into any organization', async () => {
    const { service, templateRepository } = makeService();
    const { created } = await seedPublicToolTemplates(templateRepository as any);
    expect(created).toBeGreaterThan(0);

    const publicTemplate = templateRepository.rows[0];
    expect(publicTemplate.organizationId).toBeNull();

    const { tool } = await service.installTemplate(publicTemplate.id, 'org-z', 'user-z');

    expect(tool.organizationId).toBe('org-z');
    expect(tool.httpConfig.method).toBe('GET');
    expect(tool.status).toBe(ToolStatus.ACTIVE);
  });

  it('re-seeding the public catalogue creates nothing new and keeps install counts', async () => {
    const { templateRepository } = makeService();
    const first = await seedPublicToolTemplates(templateRepository as any);
    templateRepository.rows[0].installCount = 7;

    const second = await seedPublicToolTemplates(templateRepository as any);

    expect(second.created).toBe(0);
    expect(second.updated).toBe(first.created);
    expect(templateRepository.rows).toHaveLength(first.created);
    expect(templateRepository.rows[0].installCount).toBe(7);
  });

  it('seeds no public template carrying a credential', async () => {
    const { templateRepository } = makeService();
    await seedPublicToolTemplates(templateRepository as any);

    for (const row of templateRepository.rows) {
      expect(row.httpConfig).not.toHaveProperty('headers');
      for (const value of Object.values(row.httpConfig.queryParams ?? {})) {
        // Every non-constant query value is a placeholder the installing
        // organization fills in, never a baked-in key.
        expect(String(value).length).toBeLessThan(20);
      }
      expect(row.apiConfig).not.toHaveProperty('headers');
    }
  });
});
