import { Injectable } from '@nestjs/common';

import { ConnectorRotation, RotationCapabilities, assertRotationContract } from './rotation.interface';

/**
 * The rotation providers this API knows, as data, keyed by connector
 * key. The rotation service and the connector catalog ask here; nothing
 * else holds a list. A connector with no entry rotates manually (the
 * connect method runs again). Mirrors the deployment AdapterRegistry.
 */
@Injectable()
export class RotationRegistry {
  private readonly providers = new Map<string, ConnectorRotation>();

  register(rotation: ConnectorRotation): void {
    assertRotationContract(rotation);
    if (this.providers.has(rotation.key)) throw new Error(`rotation provider ${rotation.key} registered twice`);
    this.providers.set(rotation.key, rotation);
  }

  get(key: string): ConnectorRotation | undefined {
    return this.providers.get(key);
  }

  list(): ConnectorRotation[] {
    return [...this.providers.values()];
  }

  /** What a connector's `rotation` block in the catalog answer carries: capabilities and the extra fields needed. */
  describe(): Array<{ key: string; capabilities: RotationCapabilities; requires: string[] }> {
    return this.list().map((r) => ({ key: r.key, capabilities: r.capabilities(), requires: r.requires?.() ?? [] }));
  }

  /** Capabilities for one connector; a connector without a provider can do nothing but manual rotation. */
  capabilitiesOf(key: string): RotationCapabilities {
    return this.providers.get(key)?.capabilities() ?? { create: false, revoke: false, metadata: false, refresh: false };
  }
}
