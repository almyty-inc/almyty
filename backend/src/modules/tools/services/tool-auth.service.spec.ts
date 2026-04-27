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

describe('ToolAuthService.applyApiAuth — api_key field-name compatibility', () => {
  let service: ToolAuthService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ToolAuthService,
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
