import { ForbiddenException, Injectable } from '@nestjs/common';

import { ConnectionUseInput, ConnectionUsePolicy } from '../../credentials/credential-ref.resolver';
import { GrantsService } from './grants.service';

/**
 * Gate 2 behind the consumer seam: when a consumer (LLM call, MCP call,
 * channel, API test, a deploy) resolves a credential that is a shared
 * connection, the caller must hold a grant.
 *
 * Rows a consumer manages for itself (metadata.managedBy) and plain
 * credentials are not connections and pass. A call with no principal is a
 * system path (a scheduler, the reconcile loop): it may use an
 * organization connection, but never someone's personal one, because
 * there is no one whose grant could be checked.
 */
@Injectable()
export class GrantsUsePolicy implements ConnectionUsePolicy {
  constructor(private readonly grants: GrantsService) {}

  async assertCanUse(input: ConnectionUseInput): Promise<void> {
    const { credential, principal, context } = input;
    if (!credential.connectorKey) return;
    if ((credential.metadata as Record<string, any> | null | undefined)?.managedBy) return;
    if (!principal?.id) {
      if (credential.ownerUserId) {
        throw new ForbiddenException({
          code: 'CONNECTION_NOT_GRANTED',
          message: 'a personal connection cannot be used by a system path; re-create it as an organization connection or record the acting user',
          connectionId: credential.id,
        });
      }
      return;
    }
    await this.grants.assertCanUse(
      { id: principal.id, organizationIds: principal.organizationIds } as any,
      credential,
      { purpose: context?.purpose, resourceType: context?.resourceType, resourceId: context?.resourceId },
    );
  }
}
