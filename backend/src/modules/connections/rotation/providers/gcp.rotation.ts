import { createSign } from 'crypto';

import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotateResult, RotationCapabilities, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, failOn, isoDate, requireField } from '../rotation.http';

/**
 * Google Cloud service account keys. Verified 2026-09-08 against the
 * IAM REST reference (docs/design/connections-rotation.md):
 * POST https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{email}/keys
 * with privateKeyType TYPE_GOOGLE_CREDENTIALS_FILE returns
 * `privateKeyData`, the base64 of a new key file; GET and DELETE on
 * .../keys/{private_key_id} describe (validAfterTime, validBeforeTime,
 * disabled) and remove one. The bearer token comes from the JWT bearer
 * grant at https://oauth2.googleapis.com/token, the same exchange gate
 * 1 validates with; the token URL is fixed, never read from the key
 * file. Needs iam.serviceAccountKeys.create/delete on the account.
 */
export const GCP_IAM_API = 'https://iam.googleapis.com/v1';
export const GCP_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** GCP reports "never expires" as the year 9999. */
const FOREVER_YEAR = 9999;

export class GcpRotation implements ConnectorRotation {
  readonly key = 'gcp';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: true, revoke: true, metadata: true, refresh: false };
  }

  private keyFile(secrets: DecryptedSecrets): { client_email: string; private_key: string; private_key_id?: string; project_id?: string } {
    let sa: any;
    try {
      sa = JSON.parse(requireField(secrets, 'serviceAccountJson', this.key));
    } catch (e) {
      if (e instanceof RotationError) throw e;
      throw new RotationError('ROTATION_FAILED', 'gcp: serviceAccountJson is not valid JSON');
    }
    if (sa?.type !== 'service_account' || !sa.client_email || !sa.private_key) throw new RotationError('ROTATION_FAILED', 'gcp: serviceAccountJson is not a service account key');
    return sa;
  }

  private async token(sa: { client_email: string; private_key: string; private_key_id?: string }, now?: Date): Promise<string> {
    const iat = Math.floor((now ?? new Date()).getTime() / 1000);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })}.${enc({ iss: sa.client_email, scope: SCOPE, aud: GCP_TOKEN_URL, iat, exp: iat + 300 })}`;
    let signature: string;
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(unsigned);
      signature = signer.sign(sa.private_key, 'base64url');
    } catch (e: any) {
      throw new RotationError('ROTATION_AUTH', `gcp: private_key could not sign: ${e?.message ?? e}`);
    }
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString();
    const reply = await callJson(this.http, GCP_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    if (!reply.ok || typeof reply.json?.access_token !== 'string') {
      throw new RotationError('ROTATION_AUTH', `gcp: token exchange rejected the service account (${reply.status}${reply.json?.error_description ? ': ' + reply.json.error_description : ''})`, reply.status);
    }
    return reply.json.access_token;
  }

  private keysUrl(secrets: DecryptedSecrets, sa: { client_email: string; project_id?: string }): string {
    const project = String(secrets.project || sa.project_id || '-');
    return `${GCP_IAM_API}/projects/${encodeURIComponent(project)}/serviceAccounts/${encodeURIComponent(sa.client_email)}/keys`;
  }

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private keyName(secrets: DecryptedSecrets, sa: { client_email: string; private_key_id?: string; project_id?: string }): string {
    if (!sa.private_key_id) throw new RotationError('ROTATION_FAILED', 'gcp: serviceAccountJson carries no private_key_id to address');
    return `${this.keysUrl(secrets, sa)}/${encodeURIComponent(sa.private_key_id)}`;
  }

  async rotate(current: DecryptedSecrets, ctx: { now?: Date }): Promise<RotateResult> {
    const sa = this.keyFile(current);
    const token = await this.token(sa, ctx.now);
    const reply = await callJson(this.http, this.keysUrl(current, sa), {
      method: 'POST', headers: this.headers(token), body: JSON.stringify({ privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' }),
    });
    failOn(reply, 'gcp service account key create');
    const data = reply.json?.privateKeyData;
    if (typeof data !== 'string' || !data) throw new RotationError('ROTATION_FAILED', 'gcp: key create answered without privateKeyData');
    const json = Buffer.from(data, 'base64').toString('utf8');
    try {
      JSON.parse(json);
    } catch {
      throw new RotationError('ROTATION_FAILED', 'gcp: privateKeyData did not decode to a key file');
    }
    const until = isoDate(reply.json?.validBeforeTime);
    return {
      next: { serviceAccountJson: json },
      label: `${sa.client_email} ${String(reply.json?.name ?? '').split('/').pop()?.slice(0, 8) ?? ''}`.trim(),
      expiresAt: until && until.getUTCFullYear() < FOREVER_YEAR ? until : undefined,
    };
  }

  async revoke(current: DecryptedSecrets, ctx: { now?: Date; successor?: DecryptedSecrets }): Promise<void> {
    const sa = this.keyFile(current);
    // The successor key file signs the delete: a key cannot be relied on to delete itself once disabled.
    const signer = ctx.successor?.serviceAccountJson ? this.keyFile(ctx.successor) : sa;
    const token = await this.token(signer, ctx.now);
    const reply = await callJson(this.http, this.keyName(current, sa), { method: 'DELETE', headers: this.headers(token) });
    failOn(reply, 'gcp service account key delete');
  }

  async describe(current: DecryptedSecrets, ctx: { now?: Date }): Promise<KeyDescription> {
    const sa = this.keyFile(current);
    const token = await this.token(sa, ctx.now);
    const reply = await callJson(this.http, this.keyName(current, sa), { method: 'GET', headers: this.headers(token) });
    failOn(reply, 'gcp service account key get');
    const until = isoDate(reply.json?.validBeforeTime);
    return {
      label: `${sa.client_email} ${String(sa.private_key_id).slice(0, 8)}`,
      createdAt: isoDate(reply.json?.validAfterTime),
      expiresAt: until && until.getUTCFullYear() < FOREVER_YEAR ? until : undefined,
    };
  }
}
