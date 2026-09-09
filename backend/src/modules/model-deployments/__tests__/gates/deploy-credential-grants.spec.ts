import { Credential, CredentialType } from '../../../../entities/credential.entity';
import { ConnectionGrant } from '../../../../entities/connection-grant.entity';
import { ModelDeployment } from '../../../../entities/model-deployment.entity';
import { AdapterRegistry } from '../../adapters/adapter.registry';
import { StubAdapter } from '../../adapters/stub.adapter';
import { CredentialRefResolver } from '../../../credentials/credential-ref.resolver';
import { GrantsService } from '../../../connections/grants/grants.service';
import { GrantsUsePolicy } from '../../../connections/grants/grants-use.policy';
import { ModelDeploymentsService } from '../../model-deployments.service';
import { ensureTestKey, fakeAudit, fakeEnvelope, fakeQueue, fakeRegistry, fakeRepo, newDeployment } from './fakes';

/**
 * A deployment that points at a shared connection is checked against the
 * real grant rules, not a mock: the reconcile loop runs as the person who
 * created the deployment, and a personal connection nobody granted is
 * refused rather than silently used.
 */
const ORG = 'org-grants';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const VERSION = { id: 'v-1', organizationId: ORG, name: 'q', base: 'q', registryUri: 's3://r/q@1', quantizations: [], manifestSha: 's' };

describe('deployment credentials go through the real grant rules', () => {
  let credentials: ReturnType<typeof fakeRepo<Credential>>;
  let grantRows: ReturnType<typeof fakeRepo<ConnectionGrant>>;
  let deployments: ReturnType<typeof fakeRepo<ModelDeployment>>;
  let service: ModelDeploymentsService;

  const connection = (over: Partial<Credential>) => {
    const row = Object.assign(new Credential(), {
      id: 'conn-1',
      organizationId: ORG,
      name: 'Personal OpenAI',
      type: CredentialType.API_KEY,
      connectorKey: 'openai',
      isActive: true,
      metadata: null,
      config: { token: 'sk-shared' },
      ...over,
    });
    return row;
  };

  function build(rows: Credential[], grants: ConnectionGrant[] = []) {
    ensureTestKey();
    credentials = fakeRepo<Credential>(() => new Credential(), rows);
    grantRows = fakeRepo<ConnectionGrant>(() => new ConnectionGrant(), grants);
    const memberships = fakeRepo<any>(() => ({}), [
      { id: 'm-1', userId: OWNER, organizationId: ORG, role: 'member', isActive: true },
      { id: 'm-2', userId: OTHER, organizationId: ORG, role: 'member', isActive: true },
    ]);
    const grantsService = new GrantsService(
      grantRows as any,
      credentials as any,
      memberships as any,
      fakeRepo<any>(() => ({})) as any,
      fakeRepo<any>(() => ({})) as any,
      fakeRepo<any>(() => ({})) as any,
      fakeRepo<any>(() => ({})) as any,
      fakeRepo<any>(() => ({})) as any,
      fakeAudit() as any,
    );
    const resolver = new CredentialRefResolver(credentials as any, fakeEnvelope as any);
    resolver.usePolicy(new GrantsUsePolicy(grantsService));
    const registry = new AdapterRegistry();
    registry.register(new StubAdapter({ architectures: 'any' }));
    deployments = fakeRepo<ModelDeployment>(newDeployment);
    service = new ModelDeploymentsService(
      deployments as any,
      fakeRepo<any>(() => ({}), [VERSION]) as any,
      credentials as any,
      fakeQueue() as any,
      registry,
      fakeEnvelope as any,
      fakeAudit() as any,
      fakeRegistry() as any,
      resolver,
    );
    return { grantsService };
  }

  const deployment = (createdBy: string | null) =>
    Object.assign(new ModelDeployment(), {
      id: 'dep-1',
      organizationId: ORG,
      createdBy,
      providerType: 'stub',
      providerConfig: { credentialId: 'conn-1' },
    });

  it('the owner of a personal connection may deploy with it', async () => {
    build([connection({ ownerUserId: OWNER })]);
    await expect(service.credentialsFor(deployment(OWNER))).resolves.toMatchObject({ token: 'sk-shared' });
  });

  it('another member without a grant is refused, and the grant makes it work', async () => {
    const { grantsService } = build([connection({ ownerUserId: OWNER })]);
    await expect(service.credentialsFor(deployment(OTHER))).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_GRANTED' } });

    await grantsService.grant('conn-1', { principalType: 'user', principalId: OTHER, permission: 'use' }, { id: OWNER, organizationId: ORG } as any, ORG);
    await expect(service.credentialsFor(deployment(OTHER))).resolves.toMatchObject({ token: 'sk-shared' });
  });

  it('a deployment with no recorded creator cannot use a personal connection', async () => {
    build([connection({ ownerUserId: OWNER })]);
    await expect(service.credentialsFor(deployment(null))).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_GRANTED' } });
  });

  it('an organization connection works on a system path, and an inactive one refuses everybody', async () => {
    build([connection({ ownerUserId: null })]);
    await expect(service.credentialsFor(deployment(null))).resolves.toMatchObject({ token: 'sk-shared' });

    build([connection({ ownerUserId: null, isActive: false })]);
    await expect(service.credentialsFor(deployment(OWNER))).rejects.toMatchObject({ response: { code: 'CREDENTIAL_INACTIVE' } });
  });
});
