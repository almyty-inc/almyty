import { EndpointProviderHelper } from '../endpoint-provider.helper';
import { LlmProviderStatus } from '../../../entities/llm-provider.entity';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * A provider an endpoint stands up goes inactive when the endpoint stops,
 * and says why: 'endpoint_stopped', so a passing Check again never turns
 * it back on (only a failed check's inactivity is undone that way).
 */
describe('an endpoint provider that stops', () => {
  const managed = { managedBy: { kind: 'model_endpoint', id: 'dep-1' } };

  it('goes inactive with the reason endpoint_stopped', async () => {
    const providers = fakeRepository<any>([
      { id: 'p1', organizationId: 'org-1', status: LlmProviderStatus.ACTIVE, isHealthy: true, inactiveReason: null, metadata: managed },
    ]);
    const helper = new EndpointProviderHelper(providers as any, {} as any, fakeRepository<any>() as any);

    await helper.deactivate('org-1', 'p1', 'dep-1');

    expect(providers.row('p1')).toMatchObject({ status: LlmProviderStatus.INACTIVE, isHealthy: false, inactiveReason: 'endpoint_stopped' });
  });
});
