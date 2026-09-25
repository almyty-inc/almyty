import type { ResourceVisibility } from '../../common/authorization/access-policy.service';
import type { Tool } from '../../entities/tool.entity';

/**
 * The scope a tool generated from an API carries: its API's.
 *
 * A generated tool is the API's public face -- listing it, attaching it
 * and running it all go through the tool row. A team API whose tools were
 * written org-wide was listed to the whole organization and refused only
 * at execution; a private API's tools going org-wide would publish it. So
 * the tool takes the API's visibility and team, on generation, on every
 * regeneration and whenever the API's scope changes (ApisService.update).
 * A private API's tools are its owner's.
 */
export interface ApiScopeLike {
  visibility?: ResourceVisibility | null;
  teamId?: string | null;
  ownerUserId?: string | null;
}

export type GeneratedToolScope = Pick<Tool, 'visibility' | 'teamId'> & { createdBy?: string };

export function generatedToolScope(api: ApiScopeLike | null | undefined): GeneratedToolScope {
  const visibility = api?.visibility ?? 'org';
  if (visibility === 'private' && api?.ownerUserId) {
    return { visibility: 'private', teamId: null, createdBy: api.ownerUserId };
  }
  if (visibility === 'team' && api?.teamId) {
    return { visibility: 'team', teamId: api.teamId };
  }
  return { visibility: 'org', teamId: null };
}

/** Put `tool` in its API's scope. Only for generated tools; a hand-made tool keeps the scope its author chose. */
export function applyGeneratedToolScope<T extends Pick<Tool, 'visibility' | 'teamId' | 'createdBy'>>(
  tool: T,
  api: ApiScopeLike | null | undefined,
): T {
  const scope = generatedToolScope(api);
  tool.visibility = scope.visibility;
  tool.teamId = scope.teamId;
  if (scope.createdBy) tool.createdBy = scope.createdBy;
  return tool;
}
