import type { ApiKey } from '../../entities/api-key.entity';

/**
 * What the model endpoints (`/v1/messages`, `/v1/chat/completions`,
 * `/v1/models`) need of hosted runners' pod-scoped model tokens, as a
 * token, so the agents module does not import the hosted-runners module.
 *
 * A pod token is recognisable by its prefix and nothing else: it is not
 * an API key row and not a session, so every other route refuses it the
 * way it refuses any unknown bearer. The model endpoints ask this first
 * and, for a pod token, only this.
 */
export const HOSTED_MODEL_TOKENS = Symbol('HOSTED_MODEL_TOKENS');

/** Every pod-scoped model token starts with this. */
export const HOSTED_MODEL_TOKEN_PREFIX = 'almyty_pod_';

/** Which hosted machine a model call came from; stamped on the response, the run and the audit log. */
export interface HostedModelAttribution {
  tokenId: string;
  hostedRunnerId: string;
  environmentId: string;
  workspaceId: string;
}

export interface HostedModelTokens {
  /**
   * The key-shaped principal a pod token stands for: the workspace owner,
   * in the token's organization, carrying `hostedModelToken` (the
   * attribution). Null when `token` is not a pod token at all; throws
   * UnauthorizedException for a pod token that is unknown, expired,
   * revoked, or whose pod, workspace, environment or owner is gone.
   */
  authenticate(token: string | null | undefined): Promise<ApiKey | null>;
  /** Audit one model call a pod made. Never throws. */
  recordCall(apiKey: ApiKey, call: { protocol: string; model?: string | null; agentId?: string | null }): void;
}

export function isHostedModelToken(token: unknown): token is string {
  return typeof token === 'string' && token.startsWith(HOSTED_MODEL_TOKEN_PREFIX);
}

/** The bearer a compat request presented: `Authorization: Bearer ...`, or Anthropic's `x-api-key`. */
export function presentedToken(authorization?: string | null, xApiKey?: string | null): string | null {
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim();
  if (typeof xApiKey === 'string' && xApiKey.trim()) return xApiKey.trim();
  return null;
}

export function hostedAttributionOf(apiKey: unknown): HostedModelAttribution | null {
  const a = (apiKey as { hostedModelToken?: HostedModelAttribution } | null | undefined)?.hostedModelToken;
  return a && typeof a.hostedRunnerId === 'string' ? a : null;
}

/** Response headers that say which hosted machine a model call was attributed to. */
export function hostedAttributionHeaders(apiKey: unknown): Record<string, string> {
  const a = hostedAttributionOf(apiKey);
  if (!a) return {};
  return {
    'X-Almyty-Hosted-Runner': a.hostedRunnerId,
    'X-Almyty-Environment': a.environmentId,
    'X-Almyty-Workspace': a.workspaceId,
  };
}
