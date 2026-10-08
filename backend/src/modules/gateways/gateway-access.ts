import { BadRequestException } from '@nestjs/common';
import type { ResourceVisibility } from '../../common/authorization/access-policy.service';
export const ACCESS_SCOPES = ['private', 'team', 'org', 'external_open', 'external_protected'] as const;
export type AccessScope = typeof ACCESS_SCOPES[number];
export interface EndpointScopeLike {
  type?: string | null;
  metadata?: Record<string, any> | null;
  accessScope?: AccessScope | null;
  accessTeamId?: string | null;
  visibility?: ResourceVisibility | null;
  teamId?: string | null;
}
export function normalizeGatewayAccess(scope: AccessScope | undefined | null, teamId: string | undefined | null) {
  const accessScope = scope ?? 'org';
  if (!ACCESS_SCOPES.includes(accessScope)) throw new BadRequestException('Choose who can use this endpoint');
  if (accessScope === 'team' && !teamId) throw new BadRequestException('Choose the team that can use this endpoint');
  return { accessScope, accessTeamId: accessScope === 'team' ? teamId! : null };
}
export function hasEndpointAccessScope(gateway: EndpointScopeLike): boolean {
  return !gateway.type || ['mcp', 'utcp', 'skills'].includes(gateway.type) || (gateway.type === 'a2a' && gateway.metadata?.agentApiTarget === true);
}
/** An external endpoint may serve only org-published content, regardless of dashboard visibility. */
export function endpointVisibility(gateway: EndpointScopeLike): ResourceVisibility {
  const scope = hasEndpointAccessScope(gateway) ? gateway.accessScope : undefined;
  if (scope === 'private' || scope === 'team' || scope === 'org') return scope;
  if (scope) return 'org';
  return gateway.visibility ?? 'org';
}
export function endpointTeamId(gateway: EndpointScopeLike): string | null {
  return endpointVisibility(gateway) === 'team' ? (gateway.accessScope && hasEndpointAccessScope(gateway) ? gateway.accessTeamId : gateway.teamId) ?? null : null;
}
