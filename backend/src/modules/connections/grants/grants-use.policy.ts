import { Injectable } from '@nestjs/common';

import { ConnectionUseInput, ConnectionUsePolicy } from '../../credentials/credential-ref.resolver';
import { GrantsService } from './grants.service';

/**
 * Gate 2 behind the consumer seam: when a consumer (LLM call, MCP call,
 * channel, API test) resolves a credential that is a shared connection,
 * the caller must hold a grant. Rows a consumer manages for itself
 * (metadata.managedBy) and plain credentials are not connections and
 * pass; a call without a principal is a system path and passes too,
 * because the system path is audited on its own.
 */
@Injectable()
export class GrantsUsePolicy implements ConnectionUsePolicy {
  constructor(private readonly grants: GrantsService) {}

  async assertCanUse(input: ConnectionUseInput): Promise<void> {
    const { credential, principal, context } = input;
    if (!credential.connectorKey) return;
    if ((credential.metadata as Record<string, any> | null | undefined)?.managedBy) return;
    if (!principal?.id) return;
    await this.grants.assertCanUse(
      { id: principal.id, organizationIds: principal.organizationIds } as any,
      credential,
      { purpose: context?.purpose, resourceType: context?.resourceType, resourceId: context?.resourceId },
    );
  }
}
