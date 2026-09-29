import { Model } from '../../../../entities/model.entity';
import { LlmProvider } from '../../../../entities/llm-provider.entity';
import { AuditAction } from '../../../../entities/audit-log.entity';
import { ModelRouterService } from '../model-router.service';
import { fakeRepository } from '../../../../test/fake-repository';

/**
 * A model the vendor answers MODEL_NOT_FOUND for on a real call is marked
 * unavailable, so no model list offers it again and no plan picks it.
 * The card stays: runs and audit rows point at it.
 */
describe('ModelRouterService.markModelNotFound', () => {
  const PROVIDER = '3f1c2a4e-0b7d-4c1e-9a55-2d6f8e1b0c9a';
  const card = (over: Partial<Model>): Partial<Model> => ({
    organizationId: 'org',
    name: 'card',
    providerId: PROVIDER,
    providerType: 'openai',
    endpointRef: null,
    capabilities: {},
    privacyTier: 'public',
    status: 'active',
    validationStatus: 'passed',
    metadata: { checkedBy: 'provider_check' },
    ...over,
  });

  let models: ReturnType<typeof fakeRepository<Model>>;
  let audit: { log: jest.Mock };
  let svc: ModelRouterService;

  beforeEach(() => {
    models = fakeRepository<Model>({
      make: () => new Model(),
      seed: [
        card({ id: 'retired', vendorModelId: 'gpt-4-legacy' }),
        card({ id: 'current', vendorModelId: 'gpt-5' }),
        card({ id: 'other-org', organizationId: 'org2', vendorModelId: 'gpt-4-legacy' }),
      ],
    });
    audit = { log: jest.fn().mockResolvedValue(null) };
    svc = new ModelRouterService(models as any, fakeRepository<LlmProvider>() as any, fakeRepository() as any, audit as any);
  });

  it('marks the retired model unavailable, with the reason, and leaves the rest alone', async () => {
    await svc.markModelNotFound('org', PROVIDER, 'gpt-4-legacy', 'Model "gpt-4-legacy" is not available from this provider');

    const retired = models.row('retired')!;
    expect(retired).toMatchObject({ validationStatus: 'failed', status: 'error' });
    expect(retired.lastValidationError).toContain('not available');
    expect(retired.isSelectable()).toBe(false);
    expect(models.row('current')!.isSelectable()).toBe(true);
    expect(models.row('other-org')!.isSelectable()).toBe(true);
    expect(models.rows()).toHaveLength(3);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.MODEL_VALIDATED, resourceId: 'retired', details: expect.objectContaining({ passed: false, source: 'call' }) }),
    );
  });

  it('records it once, and ignores a model on the customer cloud or one it does not know', async () => {
    await svc.markModelNotFound('org', PROVIDER, 'gpt-4-legacy', 'gone');
    await svc.markModelNotFound('org', PROVIDER, 'gpt-4-legacy', 'gone again');
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(models.row('retired')!.lastValidationError).toBe('gone');

    await svc.markModelNotFound('org', 'endpoint:current', 'gpt-5', 'gone');
    await svc.markModelNotFound('org', PROVIDER, 'never-heard-of-it', 'gone');
    expect(models.row('current')!.isSelectable()).toBe(true);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when the write fails', async () => {
    models.update.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.markModelNotFound('org', PROVIDER, 'gpt-4-legacy', 'gone')).resolves.toBeUndefined();
  });
});
