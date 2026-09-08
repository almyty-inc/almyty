import { Model } from '../model.entity';
import { ModelDeployment } from '../model-deployment.entity';
import { isEncrypted } from '../../common/security/field-crypto';

describe('Model card', () => {
  const card = (over: Partial<Model> = {}): Model =>
    Object.assign(new Model(), {
      status: 'active',
      providerId: 'p1',
      endpointRef: null,
      validationStatus: 'passed',
      pricing: { inPerMTok: 2, outPerMTok: 10, currency: 'USD' },
      pricingOverride: null,
      ...over,
    });

  it('is selectable only with a dispatch path, active status and a passing validation', () => {
    expect(card().isSelectable()).toBe(true);
    expect(card({ validationStatus: 'never' }).isSelectable()).toBe(false);
    expect(card({ validationStatus: 'failed' }).isSelectable()).toBe(false);
    expect(card({ status: 'inactive' }).isSelectable()).toBe(false);
    expect(card({ providerId: null, endpointRef: null }).isSelectable()).toBe(false);
    expect(card({ providerId: null, endpointRef: { url: 'https://x' } }).isSelectable()).toBe(true);
  });

  it('lets an operator override win over the feed', () => {
    expect(card().effectivePricing()).toEqual({ inPerMTok: 2, outPerMTok: 10, currency: 'USD' });
    expect(card({ pricingOverride: { inPerMTok: 1, outPerMTok: 5, currency: 'USD' } }).effectivePricing()).toEqual({ inPerMTok: 1, outPerMTok: 5, currency: 'USD' });
    expect(card({ pricing: null }).effectivePricing()).toBeNull();
  });
});

describe('ModelDeployment providerConfig secrets', () => {
  const deployment = (): ModelDeployment =>
    Object.assign(new ModelDeployment(), {
      organizationId: 'org-1',
      providerConfig: { apiToken: 'tok-123', region: 'us-east', hfApiKey: 'hf_abc', image: 'vllm:1' },
    });

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key-32-bytes-minimum-len';
  });

  it('encrypts secret-looking keys in place and leaves the rest alone', () => {
    const d = deployment();
    d.encryptSensitiveData();
    expect(isEncrypted(d.providerConfig.apiToken)).toBe(true);
    expect(isEncrypted(d.providerConfig.hfApiKey)).toBe(true);
    expect(d.providerConfig.region).toBe('us-east');
    expect(d.providerConfig.image).toBe('vllm:1');
    // Idempotent: a second pass does not double-encrypt.
    const once = d.providerConfig.apiToken;
    d.encryptSensitiveData();
    expect(d.providerConfig.apiToken).toBe(once);
  });

  it('hands the adapter a decrypted copy and the API a masked one', () => {
    const d = deployment();
    d.encryptSensitiveData();
    expect(d.getDecryptedProviderConfig()).toEqual({ apiToken: 'tok-123', region: 'us-east', hfApiKey: 'hf_abc', image: 'vllm:1' });
    const view = d.toPublicView();
    expect(view.providerConfig).toEqual({ apiToken: '********', region: 'us-east', hfApiKey: '********', image: 'vllm:1' });
    expect(view.organization).toBeUndefined();
  });

  it('knows which keys are secrets', () => {
    expect(ModelDeployment.isSecretKey('apiToken')).toBe(true);
    expect(ModelDeployment.isSecretKey('client_secret')).toBe(true);
    expect(ModelDeployment.isSecretKey('region')).toBe(false);
  });
});
