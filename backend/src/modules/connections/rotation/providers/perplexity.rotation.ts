import { ConnectorRotation, DecryptedSecrets, RotateResult, RotationCapabilities, RotationContext, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, failOn, keyLabel, requireField } from '../rotation.http';

/**
 * Perplexity. Verified 2026-09-08 (docs/design/connections-rotation.md):
 * POST https://api.perplexity.ai/generate_auth_token, authenticated
 * with an existing key, returns `auth_token` once (with `token_name`
 * and `created_at_epoch_seconds`); POST /revoke_auth_token with
 * `auth_token` in the body revokes one. No list or metadata endpoint,
 * so the connection's own key is enough and nothing extra is required.
 */
export const PERPLEXITY_API = 'https://api.perplexity.ai';

export class PerplexityRotation implements ConnectorRotation {
  readonly key = 'perplexity';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: true, revoke: true, metadata: false, refresh: false };
  }

  private headers(bearer: string): Record<string, string> {
    return { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async rotate(current: DecryptedSecrets, ctx: RotationContext): Promise<RotateResult> {
    const apiKey = requireField(current, 'apiKey', this.key);
    const tokenName = keyLabel(ctx);
    const reply = await callJson(this.http, `${PERPLEXITY_API}/generate_auth_token`, { method: 'POST', headers: this.headers(apiKey), body: JSON.stringify({ token_name: tokenName }) });
    failOn(reply, 'perplexity token create');
    const token = reply.json?.auth_token;
    if (typeof token !== 'string' || !token) throw new RotationError('ROTATION_FAILED', 'perplexity: token create answered without auth_token');
    return { next: { apiKey: token }, label: reply.json.token_name ?? tokenName };
  }

  async revoke(current: DecryptedSecrets, ctx: RotationContext): Promise<void> {
    const apiKey = requireField(current, 'apiKey', this.key);
    // The successor authenticates the revoke of its predecessor; a lone key revokes itself.
    const bearer = typeof ctx.successor?.apiKey === 'string' && ctx.successor.apiKey ? ctx.successor.apiKey : apiKey;
    const reply = await callJson(this.http, `${PERPLEXITY_API}/revoke_auth_token`, { method: 'POST', headers: this.headers(bearer), body: JSON.stringify({ auth_token: apiKey }) });
    failOn(reply, 'perplexity token revoke');
  }
}
