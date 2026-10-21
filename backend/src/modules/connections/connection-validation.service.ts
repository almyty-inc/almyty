import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'crypto';

import type { Dispatcher } from 'undici';

import { validateUrl, validateUrlAllowingPrivate } from '../../common/security/url-validator';
import { ssrfSafeDispatcher } from '../../common/security/safe-fetch';
import { dispatcherExempting } from '../../common/security/exempt-dispatcher';
import { agentsExempting, ssrfSafeHttpAgent, ssrfSafeHttpsAgent } from '../../common/security/ssrf-safe-agent';
import { signAwsRequest } from '../model-deployments/aws-request';
import { interpolate, readPath } from './connector-schema';
import { ConnectorDefinition, HttpProbe, ValidationResult, ValidationSpec } from './connector.types';
import { McpClientError, McpClientService } from '../mcp-sources/mcp-client.service';
import { KubeApiClient, KubeApiError, KubeClientOptions, KubeConnection, kubeConnectionFrom } from '../hosted-runners/adapters/kubernetes/kube-api.client';
import { DeniedAccess, deniedHostedRunnerAccess } from '../hosted-runners/adapters/kubernetes/access';
import { namespaceFor } from '../hosted-runners/adapters/kubernetes/manifests';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, loadHostedRunnerSettings } from '../hosted-runners/hosted-runner-settings';

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

/** Builds the Kubernetes client for the kubernetes check; specs bind a fake here. */
export type KubeProbeClientFactory = (conn: KubeConnection, options: KubeClientOptions) => Pick<KubeApiClient, 'version' | 'canI'>;
export const CONNECTIONS_KUBE_FACTORY = Symbol('CONNECTIONS_KUBE_FACTORY');

/** Lets the kubernetes check reach an API server on a private address (an in-cluster URL). Off by default. */
export const KUBERNETES_PRIVATE_URLS_ENV = 'KUBERNETES_ALLOW_PRIVATE_URLS';

const TLS_ERROR_CODES = /^(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|CERT_UNTRUSTED|ERR_TLS_CERT_ALTNAME_INVALID|ERR_OSSL_.*)$/;

/** A failed kubernetes check in the words the credential page shows. */
export function kubeErrorMessage(e: any, host: string): string {
  const code = String(e?.code ?? '');
  const message = String(e?.message ?? e);
  if (e instanceof KubeApiError) {
    if (e.status === 401) return `the cluster rejected the token (401)`;
    if (e.status === 403) return `the token may not ask the cluster what it is allowed (403)`;
    return `the cluster answered ${message}`;
  }
  if (code === 'ERR_SSRF_BLOCKED') return `server URL refused: ${message}`;
  if (TLS_ERROR_CODES.test(code) || /certificate|PEM|asn1|tls/i.test(message)) {
    return `TLS: the cluster's certificate is not trusted (${code || message}); check the CA certificate`;
  }
  return `could not reach ${host}: ${code && !message.includes(code) ? `${code} ` : ''}${message}`;
}

/** What the token may not do, as one line: "cannot create namespaces; cannot create deployments in almyty-rt-*". */
export function deniedMessage(denied: DeniedAccess[], prefix: string): string {
  const words = (list: DeniedAccess[]) => list.map((d) => `${d.verb} ${d.resource}`).join(', ');
  const cluster = denied.filter((d) => !d.namespaced);
  const namespaced = denied.filter((d) => d.namespaced);
  return [
    cluster.length ? `cannot ${words(cluster)}` : '',
    namespaced.length ? `cannot ${words(namespaced)} in ${prefix}*` : '',
  ].filter(Boolean).join('; ');
}

/**
 * Every probe goes out pinned and never follows a redirect.
 *
 * `guardUrl` checks the string; the dispatcher checks what the name
 * resolves to at connect time, which the string cannot tell. A probe run
 * under a private-URL hatch passes a host-scoped `dispatcherExempting`
 * in `init`; nothing else can switch the pin off, because an absent or
 * undefined dispatcher falls back to the pinned one.
 */
export function defaultConnectionsHttp(): ConnectionsHttp {
  return (url, init) => {
    const requested = (init as { dispatcher?: Dispatcher }).dispatcher;
    return fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      dispatcher: requested ?? ssrfSafeDispatcher,
    } as RequestInit);
  };
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
      // The endpoint passed guardUrl as a string; pin what it resolves to.
      // The SDK accepts NodeHttpHandler options here and owns no redirects.
      requestHandler: { httpAgent: ssrfSafeHttpAgent, httpsAgent: ssrfSafeHttpsAgent },
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
  /** The MCP client mcp-sources use, so the check speaks to a server the way a source will. */
  private readonly mcpClient: McpClientService;
  /** The hosted runner adapter's own client, so the check speaks to a cluster the way provisioning will. */
  private readonly kubeFactory: KubeProbeClientFactory;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(CONNECTIONS_HTTP) http?: ConnectionsHttp,
    @Optional() @Inject(CONNECTIONS_S3_FACTORY) s3Factory?: S3ProbeClientFactory,
    // Stateless; the connections module does not import mcp-sources, so
    // without an injected one the check makes its own.
    @Optional() mcpClient?: McpClientService,
    @Optional() @Inject(CONNECTIONS_KUBE_FACTORY) kubeFactory?: KubeProbeClientFactory,
  ) {
    this.http = http ?? defaultConnectionsHttp();
    this.s3Factory = s3Factory ?? defaultS3ProbeClientFactory();
    this.mcpClient = mcpClient ?? new McpClientService();
    this.kubeFactory = kubeFactory ?? ((conn, options) => new KubeApiClient(conn, options));
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
      case 'oauth2_client_credentials': return this.clientCredentials(spec, config);
      case 's3_bucket': return this.s3Bucket(config);
      case 'mcp_initialize': return this.mcpInitialize(config);
      case 'kubernetes': return this.kubernetes(config, context.organizationId);
      default: return fail(`unknown validation kind ${(spec as any).kind}`);
    }
  }

  private hatchOpen(privateUrlsEnv?: string): boolean {
    return !!privateUrlsEnv && String(this.configService.get(privateUrlsEnv) ?? process.env[privateUrlsEnv] ?? '').toLowerCase() === 'true';
  }

  private guardUrl(url: string, privateUrlsEnv?: string): string | null {
    const check = this.hatchOpen(privateUrlsEnv) ? validateUrlAllowingPrivate(url) : validateUrl(url);
    return check.valid ? null : (check.error ?? 'URL refused');
  }

  /**
   * The request init for a probe of `url`. With the private-URL hatch open,
   * the DNS pin is relaxed for this URL's host alone (it would otherwise
   * refuse the in-cluster name the hatch exists for); closed, the default
   * pinned dispatcher applies.
   */
  private probeInit(url: string, init: RequestInit, privateUrlsEnv?: string): RequestInit {
    if (!this.hatchOpen(privateUrlsEnv)) return init;
    return { ...init, dispatcher: dispatcherExempting(new URL(url).hostname) } as RequestInit;
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
      else if (auth === 'header') headers[spec.headerName ?? 'X-API-Key'] = `${spec.headerPrefix ?? ''}${String(secret)}`;
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
      res = await this.http(target, this.probeInit(url, init, spec.privateUrlsEnv));
    } catch (e: any) {
      return fail(`could not reach ${new URL(url).host}: ${e?.message ?? e}`);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) return statusToResult(res.status, shortBody(text));
    let body: unknown;
    let parsed = false;
    try {
      body = JSON.parse(text);
      parsed = true;
    } catch {
      // A 2xx without JSON still validates; the label just falls back.
    }
    // Providers that answer 200 with an in-band failure (Slack, Telegram)
    // declare `okPath`; a falsy value there is a rejected credential.
    if (spec.okPath) {
      if (!parsed) return fail('provider answered 200 with a body that is not JSON');
      if (!readPath(body, spec.okPath)) {
        const detail = readPath(body, spec.errorPath ?? 'error');
        return fail(`provider rejected the credential${detail ? ` (${shortBody(String(detail))})` : ''}`);
      }
    }
    let label: string | undefined;
    if (parsed && spec.accountLabelPath) {
      const v = readPath(body, spec.accountLabelPath);
      if (typeof v === 'string' && v.trim()) label = v.trim();
      else if (typeof v === 'number') label = String(v);
    }
    if (!label && spec.accountLabelFrom) {
      const v = config[spec.accountLabelFrom];
      if (typeof v === 'string' && v.trim()) label = v.trim();
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

  private async clientCredentials(
    spec: { tokenUrl: string; scope: string; clientIdField?: string; clientSecretField?: string },
    config: Record<string, any>,
  ): Promise<ValidationResult> {
    const tokenUrl = interpolate(spec.tokenUrl, config);
    const refused = this.guardUrl(tokenUrl);
    if (refused) return fail(`token URL refused: ${refused}`);
    const clientId = config[spec.clientIdField ?? 'clientId'];
    const clientSecret = config[spec.clientSecretField ?? 'clientSecret'];
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: String(clientId ?? ''), client_secret: String(clientSecret ?? ''), scope: spec.scope }).toString();
    const res = await this.http(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = shortBody(text);
      try { detail = JSON.parse(text).error_description ?? detail; } catch { /* keep body */ }
      return statusToResult(res.status, shortBody(String(detail)));
    }
    const tenant = config.tenantId ?? config.tenant_id;
    const label = tenant ? `${clientId}@${tenant}` : String(clientId ?? '');
    return { ok: true, status: 'valid', accountLabel: label || undefined, scopesGranted: [spec.scope] };
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

  /**
   * An MCP server: connect the way an MCP source does (McpClientService:
   * the 2026-07-28 server/discover probe, falling back to initialize), on
   * this service's pinned transport. Valid when the server answers; the
   * label is the name it gives itself.
   */
  private async mcpInitialize(config: Record<string, any>): Promise<ValidationResult> {
    const url = String(config.serverUrl ?? '');
    const refused = this.guardUrl(url, 'MCP_ALLOW_PRIVATE_URLS');
    if (refused) return fail(`server URL refused: ${refused}`);
    const headers: Record<string, string> = {};
    // A pasted token (apiKey) or a sign-in's access token (accessToken).
    const token = config.apiKey || config.accessToken;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const info = await this.mcpClient.connect({
        url,
        headers,
        timeoutMs: PROBE_TIMEOUT_MS,
        fetch: (target, init) => this.http(target, this.probeInit(url, init, 'MCP_ALLOW_PRIVATE_URLS')),
      });
      const label = info.serverInfo?.title || info.serverInfo?.name;
      return { ok: true, status: 'valid', accountLabel: typeof label === 'string' && label ? label : undefined };
    } catch (e: any) {
      if (e instanceof McpClientError) {
        if (e.code === 'MCP_HTTP_ERROR' && typeof e.data?.status === 'number') {
          return statusToResult(e.data.status, shortBody(String(e.data.body ?? '')));
        }
        if (e.code === 'MCP_CONNECT_FAILED' || e.code === 'MCP_TIMEOUT') return fail(`could not reach ${new URL(url).host}: ${e.message}`);
        if (e.code === 'MCP_URL_BLOCKED') return fail(`server URL refused: ${e.message}`);
        return fail(e.message);
      }
      return fail(String(e?.message ?? e));
    }
  }

  /**
   * A Kubernetes cluster, asked the way the hosted runner adapter will use
   * it (adapters/kubernetes): GET /version on the API server with the saved
   * CA (system roots when none) and token, then one access review per thing
   * the adapter does, in the namespace it would provision for this
   * organization. Valid only when every review is allowed; the label stays
   * the server, the detail is the cluster's version.
   */
  private async kubernetes(config: Record<string, any>, organizationId: string): Promise<ValidationResult> {
    let conn: KubeConnection;
    try {
      conn = kubeConnectionFrom(config);
    } catch (e: any) {
      return fail(String(e?.message ?? e));
    }
    const refused = this.guardUrl(conn.server, KUBERNETES_PRIVATE_URLS_ENV);
    if (refused) return fail(`server URL refused: ${refused}`);
    const host = new URL(conn.server).host;
    // The URL string passed; the agent checks what the name resolves to.
    const agent = this.hatchOpen(KUBERNETES_PRIVATE_URLS_ENV) ? agentsExempting(new URL(conn.server).hostname).httpsAgent : ssrfSafeHttpsAgent;
    const client = this.kubeFactory(conn, { timeoutMs: PROBE_TIMEOUT_MS, agent });
    const prefix = this.kubeNamespacePrefix();
    try {
      const { gitVersion } = await client.version();
      const denied = await deniedHostedRunnerAccess(client, namespaceFor(organizationId, { namespacePrefix: prefix }));
      if (denied.length) return fail(deniedMessage(denied, prefix));
      return { ok: true, status: 'valid', accountLabel: conn.server, detail: gitVersion ? `Kubernetes ${gitVersion}` : undefined };
    } catch (e: any) {
      return fail(kubeErrorMessage(e, host));
    }
  }

  /** The namespace prefix hosted runners provision under; the shipped default when the settings cannot be read. */
  private kubeNamespacePrefix(): string {
    try {
      return loadHostedRunnerSettings().cluster.namespacePrefix;
    } catch {
      return DEFAULT_HOSTED_RUNNER_SETTINGS.cluster.namespacePrefix;
    }
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
