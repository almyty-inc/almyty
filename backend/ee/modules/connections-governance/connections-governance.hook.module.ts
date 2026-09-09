import { Global, Injectable, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { CONNECTIONS_GOVERNANCE_HOOK, ConnectionsGovernanceHook } from '../../../src/common/ee-hooks/ee-hooks';
import { CONNECTION_PRINCIPAL_SOURCE, ConnectionPrincipalSource, UserPrincipals } from './seams';
import { ConnectionsGovernanceHookImpl } from './connections-governance.hook';
import { GroupPrincipalSyncService } from './group-principal-sync.service';

/**
 * Core injects these two tokens `@Optional()` from inside the providers
 * and connections modules, which sit in a forwardRef cycle. A global
 * module that imported the governance module (and through it the
 * connections module) would pull that cycle into every module's
 * resolution and deadlock the container at boot, which is exactly what
 * happened. So the global binding here imports nothing and reaches the
 * real implementation through the module reference on first use.
 */
@Injectable()
class LazyGovernanceHook implements ConnectionsGovernanceHook {
  private impl?: ConnectionsGovernanceHookImpl | null;

  constructor(private readonly moduleRef: ModuleRef) {}

  private resolve(): ConnectionsGovernanceHookImpl | null {
    if (this.impl === undefined) {
      try {
        this.impl = this.moduleRef.get(ConnectionsGovernanceHookImpl, { strict: false });
      } catch {
        // Unlicensed or governance not loaded: policy never refuses.
        this.impl = null;
      }
    }
    return this.impl;
  }

  async beforeConnect(organizationId: string, connectorKey: string, owner: 'org' | 'user'): Promise<void> {
    await this.resolve()?.beforeConnect(organizationId, connectorKey, owner);
  }

  async beforeUse(...args: Parameters<ConnectionsGovernanceHook['beforeUse']>): Promise<void> {
    await this.resolve()?.beforeUse(...(args as Parameters<ConnectionsGovernanceHookImpl['beforeUse']>));
  }
}

@Injectable()
class LazyPrincipalSource implements ConnectionPrincipalSource {
  private impl?: GroupPrincipalSyncService | null;

  constructor(private readonly moduleRef: ModuleRef) {}

  private resolve(): GroupPrincipalSyncService | null {
    if (this.impl === undefined) {
      try {
        this.impl = this.moduleRef.get(GroupPrincipalSyncService, { strict: false });
      } catch {
        this.impl = null;
      }
    }
    return this.impl;
  }

  async principalsFor(user: { id: string }, organizationId: string): Promise<UserPrincipals> {
    const impl = this.resolve();
    if (!impl) return { roles: [], teamIds: [] };
    return impl.principalsFor(user, organizationId);
  }
}

@Global()
@Module({
  providers: [
    LazyGovernanceHook,
    LazyPrincipalSource,
    { provide: CONNECTIONS_GOVERNANCE_HOOK, useExisting: LazyGovernanceHook },
    { provide: CONNECTION_PRINCIPAL_SOURCE, useExisting: LazyPrincipalSource },
  ],
  exports: [CONNECTIONS_GOVERNANCE_HOOK, CONNECTION_PRINCIPAL_SOURCE],
})
export class ConnectionsGovernanceHookModule {}
