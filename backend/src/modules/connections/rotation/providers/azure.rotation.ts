import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotateResult, RotationCapabilities, RotationContext, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, failOn, isoDate, keyLabel, requireField } from '../rotation.http';

/**
 * Microsoft Entra app registration secrets. Verified 2026-09-08 against
 * Microsoft Graph v1.0 (docs/design/connections-rotation.md):
 * POST /applications(appId='{clientId}')/addPassword returns
 * `secretText` once with `keyId`, `hint` (first three characters),
 * `startDateTime` and `endDateTime` (default two years);
 * POST .../removePassword with `keyId` answers 204; GET the application
 * with $select=passwordCredentials lists them without secrets. The
 * token is the client-credentials grant for
 * https://graph.microsoft.com/.default; the app needs
 * Application.ReadWrite.OwnedBy (or .All) and must own itself.
 */
export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

export class AzureRotation implements ConnectorRotation {
  readonly key = 'azure';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: true, revoke: true, metadata: true, refresh: false };
  }

  private ids(secrets: DecryptedSecrets): { tenantId: string; clientId: string; clientSecret: string } {
    const tenantId = requireField(secrets, 'tenantId', this.key);
    const clientId = requireField(secrets, 'clientId', this.key);
    const clientSecret = requireField(secrets, 'clientSecret', this.key);
    if (!/^[A-Za-z0-9.-]+$/.test(tenantId) || !/^[A-Za-z0-9-]+$/.test(clientId)) throw new RotationError('ROTATION_FAILED', 'azure: tenantId or clientId is not a valid identifier');
    return { tenantId, clientId, clientSecret };
  }

  private async token(secrets: DecryptedSecrets): Promise<{ token: string; clientId: string }> {
    const { tenantId, clientId, clientSecret } = this.ids(secrets);
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: GRAPH_SCOPE }).toString();
    const reply = await callJson(this.http, `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
    });
    if (!reply.ok || typeof reply.json?.access_token !== 'string') {
      throw new RotationError('ROTATION_AUTH', `azure: token request rejected (${reply.status}${reply.json?.error_description ? ': ' + String(reply.json.error_description).slice(0, 160) : ''})`, reply.status);
    }
    return { token: reply.json.access_token, clientId };
  }

  private app(clientId: string): string {
    return `${GRAPH_API}/applications(appId='${clientId}')`;
  }

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private async findCredential(secrets: DecryptedSecrets, token: string, clientId: string): Promise<any> {
    const reply = await callJson(this.http, `${this.app(clientId)}?$select=id,passwordCredentials`, { method: 'GET', headers: this.headers(token) });
    failOn(reply, 'azure application read');
    const rows: any[] = Array.isArray(reply.json?.passwordCredentials) ? reply.json.passwordCredentials : [];
    const hint = String(secrets.clientSecret).slice(0, 3);
    const hit = rows.find((r) => (secrets.secretKeyId && r?.keyId === secrets.secretKeyId) || (!secrets.secretKeyId && r?.hint === hint));
    if (!hit) throw new RotationError('ROTATION_FAILED', 'azure: the connection secret is not among the application passwordCredentials');
    return hit;
  }

  async rotate(current: DecryptedSecrets, ctx: RotationContext): Promise<RotateResult> {
    const { token, clientId } = await this.token(current);
    const reply = await callJson(this.http, `${this.app(clientId)}/addPassword`, {
      method: 'POST', headers: this.headers(token), body: JSON.stringify({ passwordCredential: { displayName: keyLabel(ctx) } }),
    });
    failOn(reply, 'azure addPassword');
    const secret = reply.json?.secretText;
    if (typeof secret !== 'string' || !secret) throw new RotationError('ROTATION_FAILED', 'azure: addPassword answered without secretText');
    return { next: { clientSecret: secret, secretKeyId: String(reply.json.keyId ?? '') }, label: reply.json.displayName, expiresAt: isoDate(reply.json.endDateTime) };
  }

  async revoke(current: DecryptedSecrets, ctx: RotationContext): Promise<void> {
    // The successor secret fetches the token when there is one; the secret being removed may already be dead.
    const signer = ctx.successor?.clientSecret ? { ...current, ...ctx.successor } : current;
    const { token, clientId } = await this.token(signer);
    const keyId = typeof current.secretKeyId === 'string' && current.secretKeyId ? current.secretKeyId : String((await this.findCredential(current, token, clientId)).keyId);
    const reply = await callJson(this.http, `${this.app(clientId)}/removePassword`, { method: 'POST', headers: this.headers(token), body: JSON.stringify({ keyId }) });
    failOn(reply, 'azure removePassword');
  }

  async describe(current: DecryptedSecrets): Promise<KeyDescription> {
    const { token, clientId } = await this.token(current);
    const hit = await this.findCredential(current, token, clientId);
    return { label: hit.displayName ?? undefined, createdAt: isoDate(hit.startDateTime), expiresAt: isoDate(hit.endDateTime) };
  }
}
