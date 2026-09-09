import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotateResult, RotationCapabilities, RotationContext, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, failOn, isoDate, keyLabel, requireField, segment } from '../rotation.http';

/**
 * xAI. Verified 2026-09-08 (docs/design/connections-rotation.md): the
 * Management API at https://management-api.x.ai, driven by a management
 * key (console Settings, Management Keys), creates keys at
 * POST /auth/teams/{teamId}/api-keys (name, acls; `apiKey` returned
 * once with `apiKeyId`, `redactedApiKey`, `createTime`, `expireTime`),
 * lists them at GET on the same path and deletes at
 * DELETE /auth/api-keys/{apiKeyId}. The list envelope's field name is
 * not pinned by the docs; both a bare array and `apiKeys` are read.
 */
export const XAI_MANAGEMENT_API = 'https://management-api.x.ai';
export const XAI_DEFAULT_ACLS = ['api-key:endpoint:*', 'api-key:model:*'];

export class XaiRotation implements ConnectorRotation {
  readonly key = 'xai';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: true, revoke: true, metadata: true, refresh: false };
  }

  requires(): string[] {
    return ['managementKey', 'teamId'];
  }

  private headers(secrets: DecryptedSecrets): Record<string, string> {
    return { Authorization: `Bearer ${requireField(secrets, 'managementKey', this.key)}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private team(secrets: DecryptedSecrets): string {
    return segment(requireField(secrets, 'teamId', this.key), 'teamId', this.key);
  }

  private async find(secrets: DecryptedSecrets): Promise<any> {
    const apiKey = requireField(secrets, 'apiKey', this.key);
    const reply = await callJson(this.http, `${XAI_MANAGEMENT_API}/auth/teams/${this.team(secrets)}/api-keys?pageSize=100`, { method: 'GET', headers: this.headers(secrets) });
    failOn(reply, 'xai key list');
    const rows: any[] = Array.isArray(reply.json) ? reply.json : Array.isArray(reply.json?.apiKeys) ? reply.json.apiKeys : [];
    const tail = apiKey.slice(-4);
    const hit = rows.find((r) => (secrets.keyId && r?.apiKeyId === secrets.keyId) || (typeof r?.redactedApiKey === 'string' && r.redactedApiKey.endsWith(tail)));
    if (!hit) throw new RotationError('ROTATION_FAILED', 'xai: the connection key is not among the team keys the management key can see');
    return hit;
  }

  async rotate(current: DecryptedSecrets, ctx: RotationContext): Promise<RotateResult> {
    const name = keyLabel(ctx);
    const reply = await callJson(this.http, `${XAI_MANAGEMENT_API}/auth/teams/${this.team(current)}/api-keys`, {
      method: 'POST', headers: this.headers(current), body: JSON.stringify({ name, acls: XAI_DEFAULT_ACLS }),
    });
    failOn(reply, 'xai key create');
    const apiKey = reply.json?.apiKey;
    if (typeof apiKey !== 'string' || !apiKey) throw new RotationError('ROTATION_FAILED', 'xai: key create answered without apiKey');
    return { next: { apiKey, keyId: String(reply.json.apiKeyId ?? '') }, label: reply.json.name ?? name, expiresAt: isoDate(reply.json.expireTime) };
  }

  async revoke(current: DecryptedSecrets): Promise<void> {
    const id = typeof current.keyId === 'string' && current.keyId ? current.keyId : String((await this.find(current)).apiKeyId);
    const reply = await callJson(this.http, `${XAI_MANAGEMENT_API}/auth/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers(current) });
    failOn(reply, 'xai key delete');
  }

  async describe(current: DecryptedSecrets): Promise<KeyDescription> {
    const hit = await this.find(current);
    return { label: hit.name, createdAt: isoDate(hit.createTime), expiresAt: isoDate(hit.expireTime) };
  }
}
