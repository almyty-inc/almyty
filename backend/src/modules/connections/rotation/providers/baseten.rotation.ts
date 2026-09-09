import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotateResult, RotationCapabilities, RotationContext, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, failOn, isoDate, keyLabel, requireField } from '../rotation.http';

/**
 * Baseten. Verified 2026-09-08 (docs/design/connections-rotation.md):
 * with an API-key-management key (type WORKSPACE_MANAGE_API_KEYS),
 * POST https://api.baseten.co/v1/api_keys (name, type) returns
 * `api_key` once, GET /v1/api_keys lists metadata (`prefix`, `name`,
 * `type`, `team_name`) and DELETE /v1/api_keys/{api_key_prefix} revokes
 * by prefix. The prefix is the part of the key before the first dot;
 * that split is an observation, not a documented guarantee, so a key
 * minted here also stores `keyPrefix` explicitly.
 */
export const BASETEN_API = 'https://api.baseten.co/v1';
export const BASETEN_KEY_TYPE = 'WORKSPACE_MANAGE_ALL';

export class BasetenRotation implements ConnectorRotation {
  readonly key = 'baseten';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: true, revoke: true, metadata: true, refresh: false };
  }

  requires(): string[] {
    return ['managementKey'];
  }

  private headers(secrets: DecryptedSecrets): Record<string, string> {
    return { Authorization: `Bearer ${requireField(secrets, 'managementKey', this.key)}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private prefix(secrets: DecryptedSecrets): string {
    if (typeof secrets.keyPrefix === 'string' && secrets.keyPrefix) return secrets.keyPrefix;
    const apiKey = requireField(secrets, 'apiKey', this.key);
    const prefix = apiKey.split('.')[0];
    if (!prefix || prefix === apiKey) throw new RotationError('ROTATION_FAILED', 'baseten: the key carries no prefix to address it by');
    return prefix;
  }

  async rotate(current: DecryptedSecrets, ctx: RotationContext): Promise<RotateResult> {
    const name = keyLabel(ctx).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const reply = await callJson(this.http, `${BASETEN_API}/api_keys`, { method: 'POST', headers: this.headers(current), body: JSON.stringify({ name, type: BASETEN_KEY_TYPE }) });
    failOn(reply, 'baseten key create');
    const apiKey = reply.json?.api_key;
    if (typeof apiKey !== 'string' || !apiKey) throw new RotationError('ROTATION_FAILED', 'baseten: key create answered without api_key');
    return { next: { apiKey, keyPrefix: String(reply.json.prefix ?? apiKey.split('.')[0] ?? '') }, label: reply.json.name ?? name };
  }

  async revoke(current: DecryptedSecrets): Promise<void> {
    const reply = await callJson(this.http, `${BASETEN_API}/api_keys/${encodeURIComponent(this.prefix(current))}`, { method: 'DELETE', headers: this.headers(current) });
    failOn(reply, 'baseten key delete');
  }

  async describe(current: DecryptedSecrets): Promise<KeyDescription> {
    const prefix = this.prefix(current);
    const reply = await callJson(this.http, `${BASETEN_API}/api_keys`, { method: 'GET', headers: this.headers(current) });
    failOn(reply, 'baseten key list');
    const rows: any[] = Array.isArray(reply.json?.api_keys) ? reply.json.api_keys : Array.isArray(reply.json) ? reply.json : [];
    const hit = rows.find((r) => r?.prefix === prefix);
    if (!hit) throw new RotationError('ROTATION_FAILED', 'baseten: the connection key is not among the keys the management key can see');
    return { label: hit.team_name ? `${hit.name} (${hit.team_name})` : hit.name ?? undefined, createdAt: isoDate(hit.created_at), lastUsedAt: isoDate(hit.last_used_at), expiresAt: isoDate(hit.expires_at) };
  }
}
