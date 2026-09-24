import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Credential, CredentialType } from '../../../../entities/credential.entity';
import { CanonicalMemoryWorkspaceConfig } from '../canonical-memory-config.entity';
import { BackendCredentialsResolver } from '../backend-credentials.resolver';
import { CredentialsService } from '../../../credentials/credentials.service';
import { CredentialRefResolver } from '../../../credentials/credential-ref.resolver';
import { fakeRepository } from '../../../../test/fake-repository';
import { makeCredentialRefFake } from '../../../../test/credential-ref.fake';

/**
 * External memory backends (Mem0, Zep, Supermemory, Vertex) get the real
 * key, through the one seam every consumer reads secrets through.
 *
 * The resolver read the credential with `CredentialsService.findById`,
 * which is the dashboard's read: it masks every secret-looking field
 * (`mem0****-key`). So a backend could never authenticate -- and the
 * read skipped what the seam enforces: the row being active, a private
 * row being its owner's only, the use policy (grants) and org governance.
 * The old unit spec hid it by stubbing findById to return plaintext.
 *
 * Both reads are wired here over the same row, so whichever one the
 * resolver takes decides the outcome.
 */
describe('memory backend credentials come from the credential seam', () => {
  const ORG = 'org-1';
  const SECRET = 'mem0-real-secret-key-0123456789';

  async function build(row: Partial<Credential>) {
    const full = { id: 'cred-1', organizationId: ORG, type: CredentialType.API_KEY, isActive: true, ...row };
    const credentials = fakeRepository<Credential>({ make: () => new Credential(), seed: [full] });
    const dashboardService = new (CredentialsService as any)(credentials) as CredentialsService;
    const store = makeCredentialRefFake();
    store.seed({ ...full });

    const configRepo = fakeRepository<any>([
      {
        id: 'cfg-1',
        scopeType: 'workspace',
        scopeId: ORG,
        overrides: { routing: { credentials: { mem0: 'cred-1' } } },
      },
    ]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        BackendCredentialsResolver,
        { provide: getRepositoryToken(CanonicalMemoryWorkspaceConfig), useValue: configRepo },
        { provide: CredentialsService, useValue: dashboardService },
        { provide: CredentialRefResolver, useValue: store.resolver },
      ],
    }).compile();
    return moduleRef.get(BackendCredentialsResolver);
  }

  const scope = { scope_type: 'workspace' as const, scope_id: ORG };

  it('hands the backend the unmasked key', async () => {
    const resolver = await build({ config: { apiKey: SECRET, baseUrl: 'https://api.mem0.ai' } });
    expect(await resolver.resolve(scope, 'mem0')).toEqual({ apiKey: SECRET, baseUrl: 'https://api.mem0.ai' });
  });

  it('refuses a deactivated credential', async () => {
    const resolver = await build({ isActive: false, config: { apiKey: SECRET } });
    expect(await resolver.resolve(scope, 'mem0')).toBeNull();
  });

  it('refuses another member\'s private credential (a backend call acts for nobody)', async () => {
    const resolver = await build({ visibility: 'private' as any, ownerUserId: 'someone', config: { apiKey: SECRET } });
    expect(await resolver.resolve(scope, 'mem0')).toBeNull();
  });

  it('refuses a credential of another organization', async () => {
    const resolver = await build({ organizationId: 'org-2', config: { apiKey: SECRET } });
    expect(await resolver.resolve(scope, 'mem0')).toBeNull();
  });
});
