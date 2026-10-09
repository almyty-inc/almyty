import { Injectable } from '@nestjs/common';

import { HostedRunnerAdapter, assertHostedAdapterContract } from './hosted-runner-adapter.interface';

/**
 * The hosted runner adapters this install knows, as data. The reconcile
 * processor asks here; nothing else holds a list of adapter names.
 */
@Injectable()
export class HostedAdapterRegistry {
  private readonly adapters = new Map<string, HostedRunnerAdapter>();

  register(adapter: HostedRunnerAdapter): void {
    assertHostedAdapterContract(adapter);
    if (this.adapters.has(adapter.key)) throw new Error(`hosted runner adapter ${adapter.key} registered twice`);
    this.adapters.set(adapter.key, adapter);
  }

  get(key: string): HostedRunnerAdapter | undefined {
    return this.adapters.get(key);
  }

  keys(): string[] {
    return [...this.adapters.keys()];
  }
}
