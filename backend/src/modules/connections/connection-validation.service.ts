import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'crypto';

import { validateUrl, validateUrlAllowingPrivate } from '../../common/security/url-validator';
import { signAwsRequest } from '../model-deployments/aws-request';
import { interpolate, readPath } from './connector-schema';
import { ConnectorDefinition, HttpProbe, ValidationResult, ValidationSpec } from './connector.types';

/** The outbound HTTP call used by every probe; specs bind a fixture here. */
export type ConnectionsHttp = (url: string, init: RequestInit) => Promise<Response>;
export const CONNECTIONS_HTTP = Symbol('CONNECTIONS_HTTP');

/** Builds an S3 client for the s3_bucket probe; the default lazily requires @aws-sdk/client-s3. */
export interface S3ProbeClient {
  headBucket(bucket: string): Promise<void>;
  listOne(bucket: string, prefix: string | undefined): Promise<void>;
}
export type S3ProbeClientFactory = (cfg: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string }) => S3ProbeClient;
export const CONNECTIONS_S3_FACTORY = Symbol('CONNECTIONS_S3_FACTORY');

const PROBE_TIMEOUT_MS = 10_000;

export function defaultConnectionsHttp(): ConnectionsHttp {
  return (url, init) => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

export function defaultS3ProbeClientFactory(): S3ProbeClientFactory {
  return (cfg) => {
    // Lazy so the SDK is only needed when a registry is actually probed.
    let sdk: any;
    try {
      sdk = require('@aws-sdk/client-s3');
    } catch {
      throw new Error('@aws-sdk/client-s3 is not installed on this API; the S3 registry probe cannot run');
    }
    const client = new sdk.S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: true,
    });
    return {
      async headBucket(bucket) { await client.send(new sdk.HeadBucketCommand({ Bucket: bucket })); },
      async listOne(bucket, prefix) { await client.send(new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 })); },
    };
  };
}

function statusToResult(status: number, detail: string): ValidationResult {
  if (status === 401 || status === 403 || status === 400) return { ok: false, status: 'failed', error: `provider rejected the credential (${status}${detail ? ': ' + detail : ''})` };
  if (status === 402 || status === 429) return { ok: false, status: 'quota', error: `provider reports a quota or billing block (${status}${detail ? ': ' + detail : ''})` };
  return { ok: false, status: 'failed', error: `provider answered ${status}${detail ? ': ' + detail : ''}` };
}

function shortBody(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function fail(error: string): ValidationResult {
  return { ok: false, status: 'failed', error };
}

/**
 * Runs a connector's validation against decrypted config values and
 * says what the credential resolves to. Never throws for a provider
 * answer: a rejected key is a result, not an exception. Every URL it
 * fetches passes the SSRF guard first.
 */
@Injectable()
export class ConnectionValidationService {
  private readonly logger = new Logger(ConnectionValidationService.name);
  private readonly http: ConnectionsHttp;
  private readonly s3Factory: S3ProbeClientFactory;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(CONNECTIONS_HTTP) http?: ConnectionsHttp,
    @Optional() @Inject(CONNECTIONS_S3_FACTORY) s3Factory?: S3ProbeClientFactory,
  ) {
    this.http = http ?? defaultConnectionsHttp();
    this.s3Factory = s3Factory ?? defaultS3ProbeClientFactory();
  }

  /** The guarded outbound call, shared with the OAuth token exchange. */
  request(url: string, init: RequestInit): Promise<Response> {
    return this.http(url, init);
  }

  async validate(connector: ConnectorDefinition, config: Record<string, any>, context: { organizationId: string }): Promise<ValidationResult> {
    try {
      const result = await this.run(connector.validation, config, context);
      if (result.ok && !result.accountLabel) result.accountLabel = this.fallbackLabel(connector, config);
      return result;
    } catch (e: any) {
      this.logger.warn(`validation of ${connector.key} threw: ${e?.message}`);
      return fail(String(e?.message ?? e));
    }
  }

  /** Provider-side revoke on disconnect; best-effort, reports whether the provider accepted it. */
  async revoke(connector: ConnectorDefinition, config: Record<string, any>): Promise<{ ok: boolean; error?: string }> {
    if (!connector.revoke) return { ok: true };
    try {
      const res = await this.httpProbe({ ...connector.revoke, method: connector.revoke.method ?? 'DELETE' }, config);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  private async run(spec: ValidationSpec, config: Record<string, any>, context: { organizationId: string }): Promise<ValidationResult> {
    switch (spec.kind) {
      case 'http': return this.httpProbe(spec, config);
      case 'format': return this.formatCheck(spec, config);
      case 'aws_caller_identity':
      case 'aws_assume_role': return this.awsIdentity(config, context.organizationId);
      case 'gcp_service_account': return this.gcpServiceAccount(config);
      case 'oauth2_client_credentials': return this.clientCredentials(spec.tokenUrl, spec.scope, config);
      case 's3_bucket': return this.s3Bucket(config);
      case 'mcp_initialize': return this.mcpInitialize(config);
      default: return fail(`unknown validation kind ${(spec as any).kind}`);
    }
  }

  private guardUrl(url: string, privateUrlsEnv?: string): string | null {
    const allowPrivate = !!privateUrlsEnv && String(this.configService.get(privateUrlsEnv) ?? process.env[privateUrlsEnv] ?? '').toLowerCase() === 'true';
    const check = allowPrivate ? validateUrlAllowingPrivate(url) : validateUrl(url);
    return check.valid ? null : (check.error ?? 'URL refused');
  }

  private async httpProbe(spec: HttpProbe, config: Record<string, any>): Promise<ValidationResult> {
    const url = interpolate(spec.url, config).replace(/([^:])\/{2,}/g, '$1/');
    const refused = this.guardUrl(url, spec.privateUrlsEnv);
    if (refused) return fail(`validation URL refused: ${refused}`);

    const headers: Record<string, string> = { Accept: 'application/json', ...(spec.headers ?? {}) };
    const secret = config[spec.secretField ?? 'apiKey'];
    let target = url;
    const auth = spec.auth ?? 'bearer';
    if (secret) {
      if (auth === 'bearer') headers['Authorization'] = `Bearer ${secret}`;
      else if (auth === 'header') headers[spec.headerName ?? 'X-API-Key'] = String(secret);
      else if (auth === 'query') {
        const u = new URL(url);
        u.searchParams.set(spec.queryParam ?? 'key', String(secret));
        target = u.toString();
      } else if (auth === 'basic') {
        const user = config[spec.usernameField ?? 'apiSecret'] ?? '';
        headers['Authorization'] = `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
      }
    }

    const init: RequestInit = { method: spec.method ?? 'GET', headers };
    if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(spec.body);
    }
    let res: Response;
    try {
      res = await this.http(target, init);
    } catch (e: any) {
      return fail(`could not reach ${new URL(url).host}: ${e?.message ?? e}`);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) return statusToResult(res.status, shortBody(text));
    let label: string | undefined;
    if (spec.accountLabelPath) {
      try {
        const v = readPath(JSON.parse(text), spec.accountLabelPath);
        if (typeof v === 'string' && v.trim()) label = v.trim();
      } catch {
        // A 2xx without JSON still validates; the label just falls back.
      }
    }
    return { ok: true, status: 'valid', accountLabel: label };
  }

  private formatCheck(spec: { fields?: Record<string, string>; accountLabelFrom?: string; urlFields?: string[] }, config: Record<string, any>): ValidationResult {
    for (const [field, pattern] of Object.entries(spec.fields ?? {})) {
      const v = config[field];
      if (v === undefined || v === null || v === '') continue;
      if (!new RegExp(pattern).test(String(v))) return fail(`${field} has an unexpected format`);
    }
    for (const field of spec.urlFields ?? []) {
      const v = config[field];
      if (!v) continue;
      const refused = this.guardUrl(String(v));
      if (refused) return fail(`${field} refused: ${refused}`);
    }
    const label = spec.accountLabelFrom ? config[spec.accountLabelFrom] : undefined;
    return { ok: true, status: 'valid', accountLabel: typeof label === 'string' && label ? label : undefined };
  }

  private platformAwsCredentials(): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null {
    const get = (k: string) => this.configService.get<string>(k) ?? process.env[k];
    const accessKeyId = get('CONNECTIONS_AWS_ACCESS_KEY_ID') ?? get('AWS_ACCESS_KEY_ID');
    const secretAccessKey = get('CONNECTIONS_AWS_SECRET_ACCESS_KEY') ?? get('AWS_SECRET_ACCESS_KEY');
    if (!accessKeyId || !secretAccessKey) return null;
    return { accessKeyId, secretAccessKey, sessionToken: get('AWS_SESSION_TOKEN') };
  }

  private async stsCall(action: string, params: Record<string, string>, region: string, credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }): Promise<{ status: number; body: string }> {
    const body = new URLSearchParams({ Action: action, Version: '2011-06-15', ...params }).toString();
    const signed = signAwsRequest({
      method: 'POST',
      url: `https://sts.${region}.amazonaws.com/`,
      service: 'sts',
      region,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Accept: 'application/json' },
      body,
      credentials,
    });
    const res = await this.http(signed.url, { method: signed.method, headers: signed.headers, body: signed.body });
    return { status: res.status, body: await res.text().catch(() => '') };
  }

  private async awsIdentity(config: Record<string, any>, organizationId: string): Promise<ValidationResult> {
    const region = String(config.region || 'us-east-1');
    let credentials = config.accessKeyId && config.secretAccessKey
      ? { accessKeyId: String(config.accessKeyId), secretAccessKey: String(config.secretAccessKey), sessionToken: config.sessionToken ? String(config.sessionToken) : undefined }
      : null;
    let assumedArn: string | undefined;
    if (!credentials && config.roleArn) {
      const platform = this.platformAwsCredentials();
      if (!platform) return fail('cross-account roles need the platform AWS identity (CONNECTIONS_AWS_ACCESS_KEY_ID / _SECRET_ACCESS_KEY); use an access key pair instead');
      const res = await this.stsCall('AssumeRole', { RoleArn: String(config.roleArn), RoleSessionName: 'almyty-connect', ExternalId: organizationId }, region, platform);
      if (res.status !== 200) return statusToResult(res.status, shortBody(res.body));
      const parsed = this.parseSts(res.body, 'AssumeRoleResult');
      const c = parsed?.Credentials;
      if (!c?.AccessKeyId || !c?.SecretAccessKey) return fail('AssumeRole answered without credentials');
      credentials = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
      assumedArn = parsed?.AssumedRoleUser?.Arn;
    }
    if (!credentials) return fail('an access key pair or a role ARN is required');
    const res = await this.stsCall('GetCallerIdentity', {}, region, credentials);
    if (res.status !== 200) return statusToResult(res.status, shortBody(res.body));
    const identity = this.parseSts(res.body, 'GetCallerIdentityResult');
    const arn = assumedArn ?? identity?.Arn;
    return { ok: true, status: 'valid', accountLabel: arn ?? identity?.Account };
  }

  /** STS answers JSON when asked (Accept), XML otherwise; read both. */
  private parseSts(body: string, resultKey: string): any {
    try {
      const json = JSON.parse(body);
      const response = json[`${resultKey.replace(/Result$/, '')}Response`] ?? json;
      return response[resultKey] ?? response;
    } catch {
      const pick = (tag: string) => body.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1];
      return {
        Arn: pick('Arn'), Account: pick('Account'), UserId: pick('UserId'),
        Credentials: { AccessKeyId: pick('AccessKeyId'), SecretAccessKey: pick('SecretAccessKey'), SessionToken: pick('SessionToken') },
        AssumedRoleUser: { Arn: pick('Arn') },
      };
    }
  }

  private async gcpServiceAccount(config: Record<string, any>): Promise<ValidationResult> {
    let sa: any;
    try {
      sa = JSON.parse(String(config.serviceAccountJson ?? ''));
    } catch {
      return fail('serviceAccountJson is not valid JSON');
    }
    if (sa?.type !== 'service_account' || !sa.client_email || !sa.private_key) return fail('serviceAccountJson is not a service account key (needs type, client_email, private_key)');
    const tokenUri = String(sa.token_uri || 'https://oauth2.googleapis.com/token');
    const refused = this.guardUrl(tokenUri);
    if (refused) return fail(`token_uri refused: ${refused}`);
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })}.${enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, iat: now, exp: now + 300 })}`;
    let signature: string;
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(unsigned);
      signature = signer.sign(sa.private_key, 'base64url');
    } catch (e: any) {
      return fail(`private_key could not sign: ${e?.message ?? e}`);
    }
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString();
    const res = await this.http(tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    const text = await res.text().catch(() => '');
    if (!res.ok) return statusToResult(res.status, shortBody(text));
    return { ok: true, status: 'valid', accountLabel: `${sa.client_email}${config.project || sa.project_id ? ` (${config.project || sa.project_id})` : ''}` };
  }

  private async clientCredentials(tokenUrlTemplate: string, scope: string, config: Record<string, any>): Promise<ValidationResult> {
    const tokenUrl = interpolate(tokenUrlTemplate, config);
    const refused = this.guardUrl(tokenUrl);
    if (refused) return fail(`token URL refused: ${refused}`);
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: String(config.clientId ?? ''), client_secret: String(config.clientSecret ?? ''), scope }).toString();
    const res = await this.http(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = shortBody(text);
      try { detail = JSON.parse(text).error_description ?? detail; } catch { /* keep body */ }
      return statusToResult(res.status, shortBody(String(detail)));
    }
    const label = config.tenantId ? `${config.clientId}@${config.tenantId}` : String(config.clientId ?? '');
    return { ok: true, status: 'valid', accountLabel: label || undefined, scopesGranted: [scope] };
  }

  private async s3Bucket(config: Record<string, any>): Promise<ValidationResult> {
    const bucket = String(config.bucket ?? '');
    const region = String(config.region || 'us-east-1');
    const endpoint = config.endpoint ? String(config.endpoint) : undefined;
    if (!bucket) return fail('bucket is required');
    if (endpoint) {
      const refused = this.guardUrl(endpoint);
      if (refused) return fail(`endpoint refused: ${refused}`);
    }
    if (!config.accessKeyId || !config.secretAccessKey) return fail('accessKeyId and secretAccessKey are required');
    let client: S3ProbeClient;
    try {
      client = this.s3Factory({ endpoint, region, accessKeyId: String(config.accessKeyId), secretAccessKey: String(config.secretAccessKey) });
    } catch (e: any) {
      return fail(String(e?.message ?? e));
    }
    try {
      await client.headBucket(bucket);
      await client.listOne(bucket, config.prefix ? String(config.prefix) : undefined);
    } catch (e: any) {
      const status = e?.$metadata?.httpStatusCode ?? e?.status;
      const name = e?.name ?? e?.Code ?? 'error';
      if (status === 403 || /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(name)) return fail(`bucket access denied (${name})`);
      if (status === 404 || /NoSuchBucket|NotFound/i.test(name)) return fail(`bucket ${bucket} was not found (${name})`);
      return fail(`bucket probe failed: ${name}${e?.message ? ': ' + e.message : ''}`);
    }
    const where = endpoint ? new URL(endpoint).host : region;
    return { ok: true, status: 'valid', accountLabel: `${bucket}@${where}` };
  }

  private async mcpInitialize(config: Record<string, any>): Promise<ValidationResult> {
    const url = String(config.serverUrl ?? '');
    const refused = this.guardUrl(url, 'MCP_ALLOW_PRIVATE_URLS');
    if (refused) return fail(`server URL refused: ${refused}`);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'almyty', version: '1' } } });
    let res: Response;
    try {
      res = await this.http(url, { method: 'POST', headers, body });
    } catch (e: any) {
      return fail(`could not reach ${new URL(url).host}: ${e?.message ?? e}`);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) return statusToResult(res.status, shortBody(text));
    let label: string | undefined;
    try {
      const json = JSON.parse(text);
      const name = readPath(json, 'result.serverInfo.name');
      if (typeof name === 'string') label = name;
    } catch {
      const m = text.match(/"name"\s*:\s*"([^"]+)"/);
      if (m) label = m[1];
    }
    return { ok: true, status: 'valid', accountLabel: label };
  }

  /** `<displayName> key ...abcd` when the provider names nothing. */
  private fallbackLabel(connector: ConnectorDefinition, config: Record<string, any>): string {
    const plain = ['workspace', 'bucket', 'baseUrl', 'serverUrl', 'specUrl', 'url', 'clientId', 'roleArn'].map((k) => config[k]).find((v) => typeof v === 'string' && v);
    if (plain) return String(plain);
    const secret = ['apiKey', 'accessToken', 'tokenId', 'accessKeyId', 'secret'].map((k) => config[k]).find((v) => typeof v === 'string' && v);
    if (secret) return `${connector.displayName} key ...${String(secret).slice(-4)}`;
    return connector.displayName;
  }
}
