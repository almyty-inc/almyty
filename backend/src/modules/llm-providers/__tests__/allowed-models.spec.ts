import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { applyModelAccess, assertModelAllowed, providerAllowsModel } from '../allowed-models';
import { DefaultModelResolver } from '../default-model.resolver';
import { UpdateLlmProviderBodyDto } from '../dto/llm-providers-controller.dto';

/**
 * A connection's models: every one allowed by default, unticked ones
 * hidden, and the "Allow new models automatically" switch deciding what a
 * model the vendor lists later does.
 */
describe('allowed models on a connection', () => {
  const row = (fields: Partial<LlmProvider>) => Object.assign(new LlmProvider(), { id: 'p1', name: 'HF', type: LlmProviderType.HUGGINGFACE, configuration: {}, ...fields });

  it('allows every model on a connection nobody changed, a row from before the switch included', () => {
    expect(providerAllowsModel(row({}), 'anything')).toBe(true);
    expect(providerAllowsModel(row({ allowNewModels: true, hiddenModels: null }), 'anything')).toBe(true);
  });

  it('switch on: hides only the unticked ones, and a model listed later is allowed', () => {
    const p = row({ allowNewModels: true, hiddenModels: ['qwen'], allowedModels: ['llama'] });
    expect(providerAllowsModel(p, 'qwen')).toBe(false);
    expect(providerAllowsModel(p, 'llama')).toBe(true);
    expect(providerAllowsModel(p, 'brand-new')).toBe(true);
  });

  it('switch off: only the ticked ones, and a model listed later stays off', () => {
    const p = row({ allowNewModels: false, hiddenModels: ['qwen'], allowedModels: ['llama'] });
    expect(providerAllowsModel(p, 'llama')).toBe(true);
    expect(providerAllowsModel(p, 'brand-new')).toBe(false);
    expect(() => assertModelAllowed(p, 'brand-new')).toThrow(/does not allow the model "brand-new"/);
    expect(() => assertModelAllowed(p, 'llama')).not.toThrow();
  });

  it('an update keeps the list it does not touch, trims and de-duplicates, and refuses to allow nothing', () => {
    const target: Partial<LlmProvider> = { allowNewModels: true, hiddenModels: ['a'], allowedModels: null };
    applyModelAccess(target, { allowNewModels: false, allowedModels: [' b ', 'b', ''] });
    expect(target).toEqual({ allowNewModels: false, hiddenModels: ['a'], allowedModels: ['b'] });
    expect(() => applyModelAccess(target, { allowedModels: [] })).toThrow(/Tick at least one model/);
    expect(target.allowedModels).toEqual(['b']);
    applyModelAccess(target, { allowNewModels: true, hiddenModels: null });
    expect(target).toEqual({ allowNewModels: true, hiddenModels: null, allowedModels: ['b'] });
  });

  it('the API accepts the three fields and nothing that is not a list of ids', async () => {
    const ok = plainToInstance(UpdateLlmProviderBodyDto, { allowNewModels: false, allowedModels: ['m'], hiddenModels: null });
    expect(await validate(ok)).toHaveLength(0);
    const bad = plainToInstance(UpdateLlmProviderBodyDto, { allowNewModels: 'yes', allowedModels: [1] });
    const fields = (await validate(bad)).map((e) => e.property).sort();
    expect(fields).toEqual(['allowNewModels', 'allowedModels']);
  });

  describe('the model a call falls back to', () => {
    const listing = (ids: string[]) => ({ fetchModelsFromProvider: jest.fn(async () => ids.map((id) => ({ id }))) });

    it('switch off: the configured default when it is ticked, else the best ticked one, without asking the vendor', async () => {
      const models = listing(['x']);
      const resolver = new DefaultModelResolver(models as any);
      const ticked = ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen3-32B'];
      expect(await resolver.resolve(row({ allowNewModels: false, allowedModels: ticked, configuration: { model: 'Qwen/Qwen3-32B' } }))).toBe('Qwen/Qwen3-32B');
      expect(await resolver.resolve(row({ allowNewModels: false, allowedModels: ticked, configuration: { model: 'gone' } }))).toBe('meta-llama/Llama-3.3-70B-Instruct');
      expect(models.fetchModelsFromProvider).not.toHaveBeenCalled();
    });

    it('switch on: never an unticked model, whether configured, cached or listed', async () => {
      const models = listing(['hidden-a', 'shown-b']);
      const resolver = new DefaultModelResolver(models as any);
      const p = row({ id: 'p9', allowNewModels: true, hiddenModels: ['hidden-a'], configuration: { model: 'hidden-a' } });
      expect(await resolver.resolve(p)).toBe('shown-b');
      // A pick cached before the model was unticked is not reused.
      const open = row({ id: 'p10', allowNewModels: true, hiddenModels: null });
      expect(await resolver.resolve(open)).toBe('hidden-a');
      open.hiddenModels = ['hidden-a'];
      expect(await resolver.resolve(open)).toBe('shown-b');
    });
  });
});
