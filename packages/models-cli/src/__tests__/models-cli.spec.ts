import { describe, expect, it } from 'vitest';
import { deployBody, formatCard, formatVersion, parseArgs, registerBody, registerEndpointBody, registerVersionBody } from '../index';


describe('@almyty/models', () => {
  it('parses commands, positionals and flags', () => {
    const args = parseArgs(['scale', 'dep-1', '2', '--json']);
    expect(args).toEqual({ command: 'scale', positional: ['dep-1', '2'], flags: { json: true } });
  });

  it('builds a register body and refuses a missing provider', () => {
    const flags = parseArgs(['register', '--name', 'Sonnet', '--provider', 'p1', '--model', 'claude-sonnet-5', '--tier', 'public', '--context', '200000']).flags;
    expect(registerBody(flags)).toEqual({ name: 'Sonnet', providerId: 'p1', vendorModelId: 'claude-sonnet-5', privacyTier: 'public', contextLength: 200000 });
    expect(() => registerBody(parseArgs(['register', '--name', 'x', '--model', 'm']).flags)).toThrow('--provider is required');
  });

  it('builds an endpoint registration with the key only when given', () => {
    const flags = parseArgs(['register-endpoint', '--name', 'box', '--url', 'https://vllm.internal/v1', '--model', 'llama', '--region', 'eu']).flags;
    expect(registerEndpointBody(flags)).toEqual({ name: 'box', url: 'https://vllm.internal/v1', vendorModelId: 'llama', region: 'eu' });
    expect(registerEndpointBody({ ...flags, 'api-key': 'k' }).apiKey).toBe('k');
  });

  it('builds a deploy body and rejects bad JSON', () => {
    const flags = parseArgs(['deploy', '--model-version', 'v1', '--adapter', 'modal', '--config', '{"tokenId":"a"}', '--desired', '{"replicas":1}', '--budget', 'b1']).flags;
    expect(deployBody(flags)).toEqual({ modelVersionId: 'v1', providerType: 'modal', providerConfig: { tokenId: 'a' }, desired: { replicas: 1 }, budgetId: 'b1' });
    expect(() => deployBody({ 'model-version': 'v1', adapter: 'modal', config: '{oops' })).toThrow('--config must be valid JSON');
  });

  it('builds a version registration and formats a version', () => {
    const flags = parseArgs(['register-version', '--name', 'qwen tiny', '--uri', 'hf://Qwen/Qwen3-0.6B-GGUF@main', '--base', 'qwen3-0.6b', '--quantizations', 'Q4_K_M, Q8_0']).flags;
    expect(registerVersionBody(flags)).toEqual({ name: 'qwen tiny', registryUri: 'hf://Qwen/Qwen3-0.6B-GGUF@main', base: 'qwen3-0.6b', quantizations: ['Q4_K_M', 'Q8_0'] });
    expect(() => registerVersionBody({ name: 'x' })).toThrow('--uri is required');
    expect(formatVersion({ id: 'v1', name: 'qwen tiny', base: 'qwen3-0.6b', sizeBytes: '1500000000', quantizations: ['Q4_K_M'], registryUri: 's3://r/q@e' })).toContain('1.50 GB');
  });

  it('formats a card with its selectability and price source', () => {

    const line = formatCard({ id: 'c1', name: 'Llama', vendorModelId: 'llama-3-8b', privacyTier: 'private_cloud', region: 'eu', effectivePricing: { inPerMTok: 0.1, outPerMTok: 0.2 }, pricingSource: 'adapter', selectable: false, validationStatus: 'failed', lastValidationError: 'timeout' });
    expect(line).toContain('llama-3-8b');
    expect(line).toContain('private_cloud/eu');
    expect(line).toContain('$0.1/$0.2 per M (adapter)');
    expect(line).toContain('not selectable (validation: failed: timeout)');
  });
});
