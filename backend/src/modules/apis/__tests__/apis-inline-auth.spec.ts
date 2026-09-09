import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ApisService } from '../apis.service';
import { Api } from '../../../entities/api.entity';
import { ApiSchema } from '../../../entities/api-schema.entity';
import { Operation } from '../../../entities/operation.entity';
import { Resource } from '../../../entities/resource.entity';
import { Organization } from '../../../entities/organization.entity';
import { SchemaParserService } from '../../schema-parser/schema-parser.service';
import { ToolsService } from '../../tools/tools.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { ApisImportHelper } from '../apis-import.helper';
import { ApisToolGeneratorHelper } from '../apis-tool-generator.helper';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { FakeCredentialStore, makeCredentialRefFake } from '../../../test/credential-ref.fake';
import { isEncrypted, encryptField } from '../../../common/security/field-crypto';
import { CredentialType } from '../../../entities/credential.entity';
import axios from 'axios';

/**
 * An API's inline `authentication.config` secret never stays on the row:
 * it becomes a Credential bound to the API (credentials.apiId, the
 * reference ToolAuthService already prefers) and the row keeps the
 * public part plus the reference.
 */
describe('ApisService inline authentication', () => {
  let service: ApisService;
  let apiRepository: any;
  let saves: any[];
  let store: FakeCredentialStore;
  let toolGen: any;

  beforeEach(async () => {
    saves = [];
    apiRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((data: any) => Object.assign(new Api(), data)),
      // Record what each save carried: the entity is mutated afterwards.
      save: jest.fn(async (api: any) => { saves.push(JSON.parse(JSON.stringify(api))); return Object.assign(api, { id: api.id ?? 'api-1' }); }),
      count: jest.fn(async () => 0),
    };
    store = makeCredentialRefFake();
    toolGen = { generateToolsFromApi: jest.fn(), applyAuthentication: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApisService,
        { provide: getRepositoryToken(Api), useValue: apiRepository },
        { provide: getRepositoryToken(ApiSchema), useValue: { findOne: jest.fn(), find: jest.fn() } },
        { provide: getRepositoryToken(Operation), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Resource), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn(async () => ({ id: 'org-1', settings: {} })) } },
        { provide: SchemaParserService, useValue: { parseApiSchema: jest.fn() } },
        { provide: ToolsService, useValue: {} },
        { provide: AuditLogService, useValue: { log: jest.fn(), logUpdate: jest.fn(), logCreate: jest.fn(), logDelete: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        { provide: ApisImportHelper, useValue: {} },
        { provide: ApisToolGeneratorHelper, useValue: toolGen },
        { provide: AccessPolicyService, useValue: { canAccess: jest.fn().mockResolvedValue({ allowed: true }), assertCanScopeToTeam: jest.fn() } },
        { provide: CredentialRefResolver, useValue: store.resolver },
      ],
    }).compile();
    service = module.get(ApisService);
  });

  it('createHttpApi stores a bearer token as a credential bound to the API and never on the row', async () => {
    apiRepository.findOne.mockResolvedValue(null);

    const saved = await service.createHttpApi(
      { name: 'Weather', baseUrl: 'https://api.example.com', authentication: { type: 'bearer', config: { token: 'plain-token' } } },
      'org-1',
    );

    expect(saves[0].authentication).toBeNull();
    expect(saved.authentication).toEqual({ type: 'bearer', config: { credentialId: store.rows[0].id } });
    expect(store.rows[0].apiId).toBe('api-1');
    expect(store.rows[0].type).toBe('bearer_token');
    expect(store.rows[0].metadata.managedBy).toEqual({ kind: 'api', id: 'api-1' });
    expect(isEncrypted(store.rows[0].config.token)).toBe(true);
    expect(JSON.stringify(saves)).not.toContain('plain-token');
  });

  it('createHttpApi keeps a secret-free authentication as it is', async () => {
    apiRepository.findOne.mockResolvedValue(null);
    const saved = await service.createHttpApi(
      { name: 'Open', baseUrl: 'https://api.example.com', authentication: { type: 'none', config: {} } },
      'org-1',
    );
    expect(saved.authentication).toEqual({ type: 'none', config: {} });
    expect(store.rows).toHaveLength(0);
    expect(apiRepository.save).toHaveBeenCalledTimes(1);
  });

  it('update moves an api_key secret into the store with keyName/keyLocation, and rotates the same row on the next update', async () => {
    const api = Object.assign(new Api(), { id: 'api-1', name: 'Weather', organizationId: 'org-1', authentication: null });
    jest.spyOn(service, 'findOne').mockResolvedValue(api);

    await service.update('api-1', { authentication: { type: 'api_key', config: { headerName: 'X-Key', apiKey: 'k-1', location: 'header' } } } as any, 'org-1');

    expect(api.authentication).toEqual({ type: 'api_key', config: { headerName: 'X-Key', location: 'header', credentialId: store.rows[0].id } });
    expect(store.rows[0].keyName).toBe('X-Key');
    expect(store.rows[0].keyLocation).toBe('header');
    expect((await store.resolver.resolve('org-1', store.rows[0].id)).config.apiKey).toBe('k-1');

    await service.update('api-1', { authentication: { type: 'api_key', config: { headerName: 'X-Key', apiKey: 'k-2', location: 'header', credentialId: store.rows[0].id } } } as any, 'org-1');

    expect(store.rows).toHaveLength(1);
    expect((await store.resolver.resolve('org-1', store.rows[0].id)).config.apiKey).toBe('k-2');
    expect(JSON.stringify(api.authentication)).not.toContain('k-2');
  });

  it('testApiConnection fills the probe auth from the credential the API points at', async () => {
    const row = store.seed({ organizationId: 'org-1', type: CredentialType.BEARER_TOKEN, config: { token: encryptField('probe-token') } });
    const api = Object.assign(new Api(), {
      id: 'api-1', name: 'Weather', organizationId: 'org-1', baseUrl: 'https://api.example.com',
      authentication: { type: 'bearer', config: { credentialId: row.id } },
    });
    jest.spyOn(service, 'findOne').mockResolvedValue(api);
    jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, headers: {}, data: {} } as any);

    const result = await service.testApiConnection('api-1', 'org-1');

    expect(result.success).toBe(true);
    expect(toolGen.applyAuthentication).toHaveBeenCalledWith(expect.anything(), { type: 'bearer', config: { token: 'probe-token' } });
    // The row itself still only carries the reference.
    expect(api.authentication).toEqual({ type: 'bearer', config: { credentialId: row.id } });
  });
});
