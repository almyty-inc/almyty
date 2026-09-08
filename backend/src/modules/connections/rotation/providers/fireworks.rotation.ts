import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotateResult, RotationCapabilities, RotationContext, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, failOn, isoDate, keyLabel, requireField, segment } from '../rotation.http';

/**
 * Fireworks AI. Verified 2026-09-08 (docs/design/connections-rotation.md):
 * the Gateway REST API creates a key for the signed-in user at
 * POST /v1/accounts/{account_id}/users/{user_id}/apiKeys (`key`
 * returned once with `keyId`, `displayName`, `createTime`, `expireTime`),
 * lists at GET on the same path and deletes at POST .../apiKeys:delete
 * with `keyId`. The connection's own key authenticates. The list does
 * not echo key values, so a key almyty did not mint (no stored keyId)
 * cannot be found for revoke or describe.
 */
export const FIREWORKS_API = 'https://api.fireworks.ai/v1';

export class FireworksRotation implements ConnectorRotation {
  readonly key = 'fireworks';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: true, revoke: true, metadata: true, refresh: false };
  }

  requires(): string[] {
    return ['accountId', 'userId'];
  }

  private headers(secrets: DecryptedSecrets): Record<string, string> {
    return { Authorization: `Bearer ${requireField(secrets, 'apiKey', this.key)}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private base(secrets: DecryptedSecrets): string {
    const account = segment(requireField(secrets, 'accountId', this.key), 'accountId', this.key);
    const user = segment(requireField(secrets, 'userId', this.key), 'userId', this.key);
    return `${FIREWORKS_API}/accounts/${account}/users/${user}/apiKeys`;
  }

  private keyId(secrets: DecryptedSecrets): string {
    if (typeof secrets.keyId !== 'string' || !secrets.keyId) throw new RotationError('ROTATION_UNSUPPORTED', 'fireworks: only keys minted by almyty carry the keyId the API addresses');
    return secrets.keyId;
  }

  async rotate(current: DecryptedSecrets, ctx: RotationContext): Promise<RotateResult> {
    const displayName = keyLabel(ctx);
    const reply = await callJson(this.http, this.base(current), { method: 'POST', headers: this.headers(current), body: JSON.stringify({ apiKey: { displayName } }) });
    failOn(reply, 'fireworks key create');
    const key = reply.json?.key;
    if (typeof key !== 'string' || !key) throw new RotationError('ROTATION_FAILED', 'fireworks: key create answered without a key');
    return { next: { apiKey: key, keyId: String(reply.json.keyId ?? '') }, label: reply.json.displayName ?? displayName, expiresAt: isoDate(reply.json.expireTime) };
  }

  async revoke(current: DecryptedSecrets, ctx: RotationContext): Promise<void> {
    const keyId = this.keyId(current);
    const signer = ctx.successor?.apiKey ? { ...current, ...ctx.successor } : current;
    const reply = await callJson(this.http, `${this.base(current)}:delete`, { method: 'POST', headers: this.headers(signer), body: JSON.stringify({ keyId }) });
    failOn(reply, 'fireworks key delete');
  }

  async describe(current: DecryptedSecrets): Promise<KeyDescription> {
    const keyId = this.keyId(current);
    const reply = await callJson(this.http, this.base(current), { method: 'GET', headers: this.headers(current) });
    failOn(reply, 'fireworks key list');
    const rows: any[] = Array.isArray(reply.json?.apiKeys) ? reply.json.apiKeys : [];
    const hit = rows.find((r) => r?.keyId === keyId);
    if (!hit) throw new RotationError('ROTATION_FAILED', 'fireworks: the connection key is not in the user key list');
    return { label: hit.displayName, createdAt: isoDate(hit.createTime), expiresAt: isoDate(hit.expireTime) };
  }
}
