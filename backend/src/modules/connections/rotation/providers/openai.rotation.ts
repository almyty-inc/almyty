import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotateResult, RotationCapabilities, RotationContext, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, failOn, keyLabel, matchesRedacted, requireField, segment, unixSeconds } from '../rotation.http';

/**
 * OpenAI. Verified 2026-09-08 against the published OpenAPI spec (see
 * docs/design/connections-rotation.md): with an Admin API key,
 * POST /v1/organization/projects/{project_id}/service_accounts mints a
 * service account whose `api_key.value` is a project key (the only
 * create path; project keys themselves have no create endpoint),
 * GET/DELETE /v1/organization/projects/{project_id}/api_keys[/{key_id}]
 * list, describe (name, created_at, last_used_at) and delete them, and
 * DELETE .../service_accounts/{id} removes an account with its key.
 */
export const OPENAI_API = 'https://api.openai.com/v1';

export class OpenAiRotation implements ConnectorRotation {
  readonly key = 'openai';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: true, revoke: true, metadata: true, refresh: false };
  }

  requires(): string[] {
    return ['adminKey', 'projectId'];
  }

  private admin(secrets: DecryptedSecrets): Record<string, string> {
    return { Authorization: `Bearer ${requireField(secrets, 'adminKey', this.key)}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private project(secrets: DecryptedSecrets): string {
    return segment(requireField(secrets, 'projectId', this.key), 'projectId', this.key);
  }

  private async findKey(secrets: DecryptedSecrets): Promise<any> {
    const apiKey = requireField(secrets, 'apiKey', this.key);
    const project = this.project(secrets);
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = `${OPENAI_API}/organization/projects/${project}/api_keys?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const reply = await callJson(this.http, url, { method: 'GET', headers: this.admin(secrets) });
      failOn(reply, 'openai project key list');
      const rows: any[] = Array.isArray(reply.json?.data) ? reply.json.data : [];
      const hit = rows.find((r) => (secrets.keyId && r?.id === secrets.keyId) || matchesRedacted(apiKey, r?.redacted_value));
      if (hit) return hit;
      if (!reply.json?.has_more || !reply.json?.last_id) break;
      after = String(reply.json.last_id);
    }
    throw new RotationError('ROTATION_FAILED', 'openai: the connection key is not among the project keys the admin key can see');
  }

  async rotate(current: DecryptedSecrets, ctx: RotationContext): Promise<RotateResult> {
    const name = keyLabel(ctx);
    const reply = await callJson(this.http, `${OPENAI_API}/organization/projects/${this.project(current)}/service_accounts`, {
      method: 'POST', headers: this.admin(current), body: JSON.stringify({ name }),
    });
    failOn(reply, 'openai service account create');
    const value = reply.json?.api_key?.value;
    if (typeof value !== 'string' || !value) throw new RotationError('ROTATION_FAILED', 'openai: service account create answered without an api_key.value');
    return {
      next: { apiKey: value, keyId: String(reply.json.api_key.id ?? ''), serviceAccountId: String(reply.json.id ?? '') },
      label: reply.json.api_key.name ?? reply.json.name ?? name,
    };
  }

  async revoke(current: DecryptedSecrets): Promise<void> {
    const project = this.project(current);
    if (typeof current.serviceAccountId === 'string' && current.serviceAccountId) {
      const reply = await callJson(this.http, `${OPENAI_API}/organization/projects/${project}/service_accounts/${encodeURIComponent(current.serviceAccountId)}`, { method: 'DELETE', headers: this.admin(current) });
      failOn(reply, 'openai service account delete');
      return;
    }
    const hit = await this.findKey(current);
    const reply = await callJson(this.http, `${OPENAI_API}/organization/projects/${project}/api_keys/${encodeURIComponent(String(hit.id))}`, { method: 'DELETE', headers: this.admin(current) });
    failOn(reply, 'openai project key delete');
  }

  async describe(current: DecryptedSecrets): Promise<KeyDescription> {
    const hit = await this.findKey(current);
    return { label: hit.name, createdAt: unixSeconds(hit.created_at), lastUsedAt: unixSeconds(hit.last_used_at) };
  }
}
