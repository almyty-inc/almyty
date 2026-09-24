/**
 * Unit tests for ToolAuthService.
 *
 * The api_key shape on api.authentication.config is fragmented:
 * the frontend writes {apiKey, headerName}, the legacy executor
 * expected {name, value}, and various other call sites use
 * {parameter, apiKey}. The injection code now accepts all three
 * — these tests pin that contract.
 */
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ModuleRef } from '@nestjs/core';
import { ToolAuthService } from './tool-auth.service';
import { Credential } from '../../../entities/credential.entity';
import { Api } from '../../../entities/api.entity';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';

describe('ToolAuthService.applyApiAuth — api_key field-name compatibility', () => {
  let service: ToolAuthService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ToolAuthService,
        { provide: EnvelopeCryptoService, useValue: makeEnvelopeCryptoMock() },
        { provide: getRepositoryToken(Credential), useValue: { findOne: jest.fn().mockResolvedValue(null) } },
        { provide: ModuleRef, useValue: { get: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(ToolAuthService);
  });

  const apiWith = (config: Record<string, any>): Api =>
    ({
      id: 'api-1',
      authentication: { type: 'api_key', config },
    }) as any;

  const opts = { organizationId: 'org-1' } as any;

  it('honors {apiKey, headerName} (frontend dialog shape)', async () => {
    const config: any = { headers: {} };
    await service.applyApiAuth(config, apiWith({ headerName: 'X-Demo', apiKey: 'frontend-secret' }), opts);
    expect(config.headers['X-Demo']).toBe('frontend-secret');
  });

  it('honors {parameter, apiKey} (UTCP / OpenAPI import shape)', async () => {
    const config: any = { headers: {} };
    await service.applyApiAuth(config, apiWith({ parameter: 'X-Param', apiKey: 'utcp-secret' }), opts);
    expect(config.headers['X-Param']).toBe('utcp-secret');
  });

  it('honors legacy {name, value} shape', async () => {
    const config: any = { headers: {} };
    await service.applyApiAuth(config, apiWith({ name: 'X-Legacy', value: 'legacy-secret' }), opts);
    expect(config.headers['X-Legacy']).toBe('legacy-secret');
  });

  it('puts the key on params when location=query', async () => {
    const config: any = { headers: {} };
    await service.applyApiAuth(
      config,
      apiWith({ headerName: 'token', apiKey: 'q-secret', location: 'query' }),
      opts,
    );
    expect(config.params).toEqual({ token: 'q-secret' });
    expect(config.headers['token']).toBeUndefined();
  });

  it('skips silently when neither header name nor key is present', async () => {
    const config: any = { headers: {} };
    await service.applyApiAuth(config, apiWith({}), opts);
    expect(config.headers).toEqual({});
  });

  it('still applies bearer/basic auth correctly (regression check)', async () => {
    const cfg1: any = { headers: {} };
    await service.applyApiAuth(
      cfg1,
      { id: 'a', authentication: { type: 'bearer', config: { token: 'tok' } } } as any,
      opts,
    );
    expect(cfg1.headers.Authorization).toBe('Bearer tok');

    const cfg2: any = { headers: {} };
    await service.applyApiAuth(
      cfg2,
      { id: 'b', authentication: { type: 'basic', config: { username: 'u', password: 'p' } } } as any,
      opts,
    );
    expect(cfg2.headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });
});

/**
 * Tenant scoping on the stored-credential path.
 *
 * `applyApiAuth` resolves the secret with
 * `where: { apiId, organizationId, isActive: true }` and is the single
 * place a tool execution picks a credential up. Every spec that touches
 * it stubs the repository with `findOne: jest.fn().mockResolvedValue(...)`
 * -- a double that ignores its `where` -- so the `organizationId` half
 * could be deleted and nothing went red, while an execution in one
 * tenant would then pick up another tenant's credential for the same
 * api id.
 */
describe('ToolAuthService.applyApiAuth — credential lookup is tenant-scoped', () => {
  const rows: any[] = [];

  const credentialRepository = {
    findOne: jest.fn(async ({ where }: any) => {
      const hit = rows.find((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value),
      );
      return hit ? Object.assign(Object.create(Object.getPrototypeOf(hit)), hit) : null;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  let service: ToolAuthService;

  beforeEach(async () => {
    rows.length = 0;
    credentialRepository.findOne.mockClear();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ToolAuthService,
        { provide: EnvelopeCryptoService, useValue: makeEnvelopeCryptoMock() },
        { provide: getRepositoryToken(Credential), useValue: credentialRepository },
        { provide: ModuleRef, useValue: { get: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(ToolAuthService);
  });

  const storedBearer = (organizationId: string) =>
    Object.assign(new Credential(), {
      id: `cred-${organizationId}`,
      apiId: 'api-1',
      organizationId,
      isActive: true,
      type: 'bearer_token',
      config: { token: `token-of-${organizationId}` },
    });

  const api = { id: 'api-1', authentication: null } as any;

  it('uses the credential that belongs to the calling organization', async () => {
    rows.push(storedBearer('org-2'), storedBearer('org-1'));
    const config: any = { headers: {} };

    await service.applyApiAuth(config, api, { organizationId: 'org-1' } as any);

    expect(config.headers.Authorization).toBe('Bearer token-of-org-1');
  });

  it('does not reach for another organization’s credential', async () => {
    rows.push(storedBearer('org-2'));
    const config: any = { headers: {} };

    await service.applyApiAuth(config, api, { organizationId: 'org-1' } as any);

    expect(config.headers.Authorization).toBeUndefined();
  });

  it('ignores a deactivated credential rather than using it', async () => {
    const stale = storedBearer('org-1');
    stale.isActive = false;
    rows.push(stale);
    const config: any = { headers: {} };

    await service.applyApiAuth(config, api, { organizationId: 'org-1' } as any);

    expect(config.headers.Authorization).toBeUndefined();
  });
});
