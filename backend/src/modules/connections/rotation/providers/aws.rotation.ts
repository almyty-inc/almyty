import { signAwsRequest } from '../../../model-deployments/aws-request';
import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotateResult, RotationCapabilities, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, isoDate, requireField, shortError } from '../rotation.http';

/**
 * AWS access key pairs. Verified 2026-09-08 against the IAM API
 * reference (docs/design/connections-rotation.md): CreateAccessKey
 * returns the new pair once, DeleteAccessKey removes one,
 * ListAccessKeys carries CreateDate and Status, GetAccessKeyLastUsed
 * carries LastUsedDate. UserName is optional: IAM infers it from the
 * signing key. IAM is a global service signed for us-east-1 with the
 * 2010-05-08 query API. A cross-account role connection has no key to
 * rotate and answers ROTATION_UNSUPPORTED.
 */
export const IAM_ENDPOINT = 'https://iam.amazonaws.com/';
export const IAM_VERSION = '2010-05-08';

export class AwsRotation implements ConnectorRotation {
  readonly key = 'aws';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: true, revoke: true, metadata: true, refresh: false };
  }

  private credentials(secrets: DecryptedSecrets) {
    if (!secrets.accessKeyId || !secrets.secretAccessKey) {
      throw new RotationError('ROTATION_UNSUPPORTED', 'aws: only access key pairs rotate; a cross-account role has no key to replace');
    }
    return { accessKeyId: String(secrets.accessKeyId), secretAccessKey: String(secrets.secretAccessKey), sessionToken: secrets.sessionToken ? String(secrets.sessionToken) : undefined };
  }

  private async iam(action: string, params: Record<string, string>, secrets: DecryptedSecrets, now?: Date): Promise<any> {
    const body = new URLSearchParams({ Action: action, Version: IAM_VERSION, ...params }).toString();
    const signed = signAwsRequest({
      method: 'POST', url: IAM_ENDPOINT, service: 'iam', region: 'us-east-1',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Accept: 'application/json' },
      body, credentials: this.credentials(secrets), now,
    });
    const reply = await callJson(this.http, signed.url, { method: signed.method, headers: signed.headers, body: signed.body });
    if (!reply.ok) {
      const code = String(reply.json?.Error?.Code ?? reply.text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? '');
      const message = reply.json?.Error?.Message ?? reply.text.match(/<Message>([^<]+)<\/Message>/)?.[1] ?? shortError(reply);
      if (reply.status === 401 || reply.status === 403 || /AccessDenied|InvalidClientTokenId|SignatureDoesNotMatch|ExpiredToken|UnrecognizedClient/i.test(code)) {
        throw new RotationError('ROTATION_AUTH', `aws ${action}: credential rejected (${code || reply.status}: ${message})`, reply.status);
      }
      if (/LimitExceeded/i.test(code)) {
        throw new RotationError('ROTATION_FAILED', `aws ${action}: the user already has two access keys; delete one in IAM first`, reply.status);
      }
      throw new RotationError('ROTATION_FAILED', `aws ${action}: ${code || reply.status} ${message}`.trim(), reply.status);
    }
    return this.result(reply.json, reply.text, action);
  }

  /** IAM answers JSON when asked; the XML fallback covers a proxy that ignores Accept. */
  private result(json: any, text: string, action: string): any {
    if (json) return json[`${action}Response`]?.[`${action}Result`] ?? json;
    const pick = (tag: string) => text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
    return {
      AccessKey: { AccessKeyId: pick('AccessKeyId'), SecretAccessKey: pick('SecretAccessKey'), CreateDate: pick('CreateDate'), UserName: pick('UserName') },
      AccessKeyLastUsed: { LastUsedDate: pick('LastUsedDate'), ServiceName: pick('ServiceName'), Region: pick('Region') },
      UserName: pick('UserName'),
      AccessKeyMetadata: [...text.matchAll(/<member>([\s\S]*?)<\/member>/g)].map((m) => ({
        AccessKeyId: m[1].match(/<AccessKeyId>([^<]*)</)?.[1], CreateDate: m[1].match(/<CreateDate>([^<]*)</)?.[1], Status: m[1].match(/<Status>([^<]*)</)?.[1],
      })),
    };
  }

  private userParam(secrets: DecryptedSecrets): Record<string, string> {
    return typeof secrets.iamUserName === 'string' && secrets.iamUserName ? { UserName: secrets.iamUserName } : {};
  }

  async rotate(current: DecryptedSecrets, ctx: { now?: Date }): Promise<RotateResult> {
    const result = await this.iam('CreateAccessKey', this.userParam(current), current, ctx.now);
    const key = result?.AccessKey ?? {};
    if (!key.AccessKeyId || !key.SecretAccessKey) throw new RotationError('ROTATION_FAILED', 'aws CreateAccessKey: answered without an access key');
    return {
      // The new pair is long-term: any session token from the old config no longer applies.
      next: { accessKeyId: String(key.AccessKeyId), secretAccessKey: String(key.SecretAccessKey), sessionToken: '' },
      label: key.UserName ? `${key.UserName} ${String(key.AccessKeyId).slice(-4)}` : String(key.AccessKeyId),
    };
  }

  async revoke(current: DecryptedSecrets, ctx: { now?: Date; successor?: DecryptedSecrets }): Promise<void> {
    requireField(current, 'accessKeyId', this.key);
    // Sign with the successor when there is one: IAM lets a key delete itself, but a live key is the safer signer.
    const signer = ctx.successor?.accessKeyId && ctx.successor?.secretAccessKey ? ctx.successor : current;
    await this.iam('DeleteAccessKey', { AccessKeyId: String(current.accessKeyId), ...this.userParam(current) }, signer, ctx.now);
  }

  async describe(current: DecryptedSecrets, ctx: { now?: Date }): Promise<KeyDescription> {
    const id = requireField(current, 'accessKeyId', this.key);
    const used = await this.iam('GetAccessKeyLastUsed', { AccessKeyId: id }, current, ctx.now);
    const listed = await this.iam('ListAccessKeys', this.userParam(current), current, ctx.now);
    const rows: any[] = Array.isArray(listed?.AccessKeyMetadata) ? listed.AccessKeyMetadata : listed?.AccessKeyMetadata?.member ?? [];
    const mine = rows.find((r) => r?.AccessKeyId === id);
    const created = typeof mine?.CreateDate === 'number' ? new Date(mine.CreateDate * 1000) : isoDate(mine?.CreateDate);
    const lastUsed = typeof used?.AccessKeyLastUsed?.LastUsedDate === 'number' ? new Date(used.AccessKeyLastUsed.LastUsedDate * 1000) : isoDate(used?.AccessKeyLastUsed?.LastUsedDate);
    return { label: used?.UserName ? `${used.UserName} ${id.slice(-4)}` : id, createdAt: created, lastUsedAt: lastUsed };
  }
}
