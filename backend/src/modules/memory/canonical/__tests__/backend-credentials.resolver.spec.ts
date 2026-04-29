/**
 * BackendCredentialsResolver unit test.
 *
 * Mocks the workspace_config repository and CredentialsService so
 * the resolver's logic — routing-config lookup, decrypted-config
 * field picking, TTL caching, invalidation — is covered without
 * spinning up Postgres. The cross-tenant integration coverage of
 * the Credential entity itself lives in cross-tenant-isolation.spec.
 */
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CanonicalMemoryWorkspaceConfig } from '../canonical-memory-config.entity';
import { BackendCredentialsResolver } from '../backend-credentials.resolver';
import { CredentialsService } from '../../../credentials/credentials.service';

describe('BackendCredentialsResolver', () => {
  let resolver: BackendCredentialsResolver;
  let configRepo: any;
  let credSvc: any;

  beforeEach(async () => {
    configRepo = { findOne: jest.fn() };
    credSvc = { findById: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        BackendCredentialsResolver,
        { provide: getRepositoryToken(CanonicalMemoryWorkspaceConfig), useValue: configRepo },
        { provide: CredentialsService, useValue: credSvc },
      ],
    }).compile();
    resolver = moduleRef.get(BackendCredentialsResolver);
  });

  it('returns null when no workspace_config row exists', async () => {
    configRepo.findOne.mockResolvedValueOnce(null);
    const out = await resolver.resolve(
      { scope_type: 'workspace', scope_id: 'wks_1' },
      'mem0',
    );
    expect(out).toBeNull();
    expect(credSvc.findById).not.toHaveBeenCalled();
  });

  it('returns null when routing has no credential id for the requested backend', async () => {
    configRepo.findOne.mockResolvedValueOnce({
      overrides: { routing: { memory_backend: 'mem0' } }, // no credentials map
    });
    const out = await resolver.resolve(
      { scope_type: 'workspace', scope_id: 'wks_1' },
      'mem0',
    );
    expect(out).toBeNull();
  });

  it('returns null when the wired-up credential id no longer exists for the org', async () => {
    configRepo.findOne.mockResolvedValueOnce({
      overrides: { routing: { credentials: { mem0: 'cred-missing' } } },
    });
    credSvc.findById.mockRejectedValueOnce(new Error('Credential not found'));
    const out = await resolver.resolve(
      { scope_type: 'workspace', scope_id: 'wks_1' },
      'mem0',
    );
    expect(out).toBeNull();
  });

  it('returns the decrypted apiKey + baseUrl for a Mem0 credential', async () => {
    configRepo.findOne.mockResolvedValueOnce({
      overrides: { routing: { credentials: { mem0: 'cred-1' } } },
    });
    credSvc.findById.mockResolvedValueOnce({
      id: 'cred-1',
      organizationId: 'wks_1',
      config: { apiKey: 'mem0-real-key', baseUrl: 'https://api.mem0.ai' },
    });
    const out = await resolver.resolve(
      { scope_type: 'workspace', scope_id: 'wks_1' },
      'mem0',
    );
    expect(out).toEqual({ apiKey: 'mem0-real-key', baseUrl: 'https://api.mem0.ai' });
  });

  it('forwards Vertex-style multi-field credentials (project / location / engine / bearer)', async () => {
    configRepo.findOne.mockResolvedValueOnce({
      overrides: { routing: { credentials: { 'vertex-memory-bank': 'cred-vertex' } } },
    });
    credSvc.findById.mockResolvedValueOnce({
      id: 'cred-vertex',
      organizationId: 'wks_1',
      config: {
        project: 'gcp-test-project',
        location: 'us-central1',
        engine: 'projects/gcp-test-project/locations/us-central1/reasoningEngines/abc',
        bearer: 'ya29.fake-token',
      },
    });
    const out = await resolver.resolve(
      { scope_type: 'workspace', scope_id: 'wks_1' },
      'vertex-memory-bank',
    );
    expect(out).toMatchObject({
      project: 'gcp-test-project',
      location: 'us-central1',
      engine: 'projects/gcp-test-project/locations/us-central1/reasoningEngines/abc',
      bearer: 'ya29.fake-token',
    });
  });

  it('caches resolved credentials within the TTL', async () => {
    configRepo.findOne.mockResolvedValue({
      overrides: { routing: { credentials: { mem0: 'cred-1' } } },
    });
    credSvc.findById.mockResolvedValue({
      id: 'cred-1', organizationId: 'wks_1',
      config: { apiKey: 'cached-key' },
    });
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_1' };
    await resolver.resolve(scope, 'mem0');
    await resolver.resolve(scope, 'mem0');
    await resolver.resolve(scope, 'mem0');
    // findById called once — subsequent reads served from cache.
    expect(credSvc.findById).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces the next resolve to hit the DB again', async () => {
    configRepo.findOne.mockResolvedValue({
      overrides: { routing: { credentials: { mem0: 'cred-1' } } },
    });
    credSvc.findById
      .mockResolvedValueOnce({ id: 'cred-1', organizationId: 'wks_1', config: { apiKey: 'old' } })
      .mockResolvedValueOnce({ id: 'cred-1', organizationId: 'wks_1', config: { apiKey: 'new' } });
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_1' };
    const a = await resolver.resolve(scope, 'mem0');
    expect(a!.apiKey).toBe('old');
    resolver.invalidate(scope, 'mem0');
    const b = await resolver.resolve(scope, 'mem0');
    expect(b!.apiKey).toBe('new');
  });

  it('invalidate() with no backendId clears every cached entry for the scope', async () => {
    configRepo.findOne.mockResolvedValue({
      overrides: {
        routing: {
          credentials: { mem0: 'cred-1', zep: 'cred-2' },
        },
      },
    });
    credSvc.findById.mockImplementation(async (id: string) => ({
      id, organizationId: 'wks_1', config: { apiKey: `key-${id}` },
    }));
    const scope = { scope_type: 'workspace' as const, scope_id: 'wks_1' };
    await resolver.resolve(scope, 'mem0');
    await resolver.resolve(scope, 'zep');
    expect(credSvc.findById).toHaveBeenCalledTimes(2);

    resolver.invalidate(scope); // both
    await resolver.resolve(scope, 'mem0');
    await resolver.resolve(scope, 'zep');
    expect(credSvc.findById).toHaveBeenCalledTimes(4);
  });
});
