import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotateResult, RotationCapabilities, RotationContext, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, failOn, isoDate, keyLabel, requireField } from '../rotation.http';

/**
 * OpenRouter. Verified 2026-09-08 (docs/design/connections-rotation.md):
 * a provisioning key (openrouter.ai/settings/provisioning-keys) drives
 * POST / GET / DELETE https://openrouter.ai/api/v1/keys[/{hash}], and
 * GET https://openrouter.ai/api/v1/key answers with the calling key's
 * own label, limit and usage. A key minted through PKCE or pasted by
 * hand carries no hash, so revoke finds it by label in the list.
 */
export const OPENROUTER_API = 'https://openrouter.ai/api/v1';

export class OpenRouterRotation implements ConnectorRotation {
  readonly key = 'openrouter';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: true, revoke: true, metadata: true, refresh: false };
  }

  requires(): string[] {
    return ['provisioningKey'];
  }

  private provisioning(secrets: DecryptedSecrets): Record<string, string> {
    return { Authorization: `Bearer ${requireField(secrets, 'provisioningKey', this.key)}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  /** The calling key's own record: no provisioning key needed. */
  private async self(secrets: DecryptedSecrets): Promise<any> {
    const apiKey = requireField(secrets, 'apiKey', this.key);
    const reply = await callJson(this.http, `${OPENROUTER_API}/key`, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    failOn(reply, 'openrouter key lookup');
    return reply.json?.data ?? {};
  }

  private async hashOf(secrets: DecryptedSecrets): Promise<string> {
    if (typeof secrets.keyHash === 'string' && secrets.keyHash) return secrets.keyHash;
    const label = (await this.self(secrets)).label;
    if (!label) throw new RotationError('ROTATION_FAILED', 'openrouter: the key reports no label to match in the key list');
    const reply = await callJson(this.http, `${OPENROUTER_API}/keys?include_disabled=false`, { method: 'GET', headers: this.provisioning(secrets) });
    failOn(reply, 'openrouter key list');
    const rows: any[] = Array.isArray(reply.json?.data) ? reply.json.data : [];
    const hit = rows.find((r) => r?.label === label || r?.name === label);
    if (!hit?.hash) throw new RotationError('ROTATION_FAILED', `openrouter: no key labelled ${JSON.stringify(label)} in the provisioning list`);
    return String(hit.hash);
  }

  async rotate(current: DecryptedSecrets, ctx: RotationContext): Promise<RotateResult> {
    const name = keyLabel(ctx);
    const body: Record<string, unknown> = { name };
    if (typeof current.keyLimit === 'number') body.limit = current.keyLimit;
    const reply = await callJson(this.http, `${OPENROUTER_API}/keys`, { method: 'POST', headers: this.provisioning(current), body: JSON.stringify(body) });
    failOn(reply, 'openrouter key create');
    const key = reply.json?.key ?? reply.json?.data?.key;
    if (typeof key !== 'string' || !key) throw new RotationError('ROTATION_FAILED', 'openrouter: key create answered without a key');
    const data = reply.json?.data ?? {};
    return { next: { apiKey: key, keyHash: String(data.hash ?? '') }, label: data.name ?? data.label ?? name };
  }

  async revoke(current: DecryptedSecrets): Promise<void> {
    const hash = await this.hashOf(current);
    const reply = await callJson(this.http, `${OPENROUTER_API}/keys/${encodeURIComponent(hash)}`, { method: 'DELETE', headers: this.provisioning(current) });
    failOn(reply, 'openrouter key delete');
  }

  async describe(current: DecryptedSecrets): Promise<KeyDescription> {
    if (typeof current.keyHash === 'string' && current.keyHash && current.provisioningKey) {
      const reply = await callJson(this.http, `${OPENROUTER_API}/keys/${encodeURIComponent(current.keyHash)}`, { method: 'GET', headers: this.provisioning(current) });
      failOn(reply, 'openrouter key get');
      const d = reply.json?.data ?? {};
      return { label: d.name ?? d.label, createdAt: isoDate(d.created_at) };
    }
    const d = await this.self(current);
    return { label: typeof d.label === 'string' ? d.label : undefined };
  }
}
