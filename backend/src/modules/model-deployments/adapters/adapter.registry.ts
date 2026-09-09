import { Injectable } from '@nestjs/common';
import { ModelProviderAdapter, assertAdapterContract } from './adapter.interface';
import { schemesFor } from '../model-source';

/**
 * The adapters this deployment knows, as data. Forms, the reconcile loop
 * and the router ask here; nothing else holds a list of provider names.
 * An adapter an org admin disables in Settings is filtered out by the
 * caller, not removed here.
 */
@Injectable()
export class AdapterRegistry {
  private readonly adapters = new Map<string, ModelProviderAdapter>();

  register(adapter: ModelProviderAdapter): void {
    assertAdapterContract(adapter);
    if (this.adapters.has(adapter.key)) {
      throw new Error(`adapter ${adapter.key} registered twice`);
    }
    this.adapters.set(adapter.key, adapter);
  }

  get(key: string): ModelProviderAdapter | undefined {
    return this.adapters.get(key);
  }

  require(key: string): ModelProviderAdapter {
    const adapter = this.adapters.get(key);
    if (!adapter) throw Object.assign(new Error(`unknown deployment adapter: ${key}`), { code: 'ADAPTER_UNKNOWN' });
    return adapter;
  }

  list(): ModelProviderAdapter[] {
    return [...this.adapters.values()];
  }

  /** What GET /model-adapters serves: everything a form needs and nothing else. */
  /**
   * Everything a form needs. `modelSchemes` says which kinds of model
   * this provider can actually run, so the UI can filter both ways: the
   * providers that can run the model you have, and the model sources a
   * provider you picked will accept.
   */
  describe(): Array<{
    key: string;
    displayName: string;
    capabilities: ReturnType<ModelProviderAdapter['capabilities']>;
    configSchema: Record<string, any>;
    modelSchemes: string[];
  }> {
    return this.list().map((a) => ({
      key: a.key,
      displayName: a.displayName,
      capabilities: a.capabilities(),
      configSchema: a.configSchema(),
      modelSchemes: schemesFor(a.key, a.capabilities()).map((s) => `${s}://`),
    }));
  }
}
