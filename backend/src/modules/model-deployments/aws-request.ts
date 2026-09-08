import { createHash, createHmac } from 'crypto';

/**
 * Just enough of AWS Signature Version 4 for the Bedrock and SageMaker
 * adapters, plus the error classifier they share.
 *
 * The AWS SDK clients for those services are not installed (only
 * client-kms is), and the adapters must not pull in packages. Both
 * services speak JSON over HTTPS, so a signer and an injected HTTP client
 * are all an adapter needs; fixtures inspect the signed request and
 * decide from the Credential scope whether the key is "valid".
 *
 * Canonical URI: every service except S3 wants the path escaped a second
 * time, so a path given here already percent-encoded is escaped again for
 * the canonical request only; the wire path is sent as given.
 */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsRequestInput {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  service: string;
  region: string;
  headers?: Record<string, string>;
  body?: string;
  credentials: AwsCredentials;
  now?: Date;
}

export interface SignedAwsRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 escaping, which is stricter than encodeURIComponent about !'()*. */
function rfc3986(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(search: URLSearchParams): string {
  const pairs: string[] = [];
  for (const [k, v] of search.entries()) pairs.push(`${rfc3986(k)}=${rfc3986(v)}`);
  return pairs.sort().join('&');
}

export function amzDate(now: Date): { dateTime: string; date: string } {
  const dateTime = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { dateTime, date: dateTime.slice(0, 8) };
}

export function signAwsRequest(input: AwsRequestInput): SignedAwsRequest {
  const url = new URL(input.url);
  const { dateTime, date } = amzDate(input.now ?? new Date());
  const body = input.body ?? '';

  const headers: Record<string, string> = { ...(input.headers ?? {}), host: url.host, 'x-amz-date': dateTime };
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;

  const lower = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const).sort(([a], [b]) => (a < b ? -1 : 1));
  const canonicalHeaders = lower.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = lower.map(([k]) => k).join(';');

  const canonicalUri = url.pathname.split('/').map((s) => rfc3986(s)).join('/') || '/';
  const canonicalRequest = [input.method, canonicalUri, canonicalQuery(url.searchParams), canonicalHeaders, signedHeaders, sha256Hex(body)].join('\n');

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', dateTime, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { method: input.method, url: input.url, headers, body: input.body };
}

/** Access key id from a signed request's Authorization header; fixtures use it to decide whether the key is valid. */
export function accessKeyOf(authorization: string | undefined): string | undefined {
  return authorization?.match(/Credential=([^/]+)\//)?.[1];
}

/**
 * The minimal HTTP client an AWS adapter needs: axios' `request` shape.
 * Non-2xx must reject with `response.{status,data,headers}` attached,
 * which axios does by default.
 */
export interface AwsHttp {
  request(config: { method: string; url: string; headers: Record<string, string>; data?: string; timeout?: number }): Promise<{ status: number; data: any; headers?: Record<string, any> }>;
}

/**
 * Maps an AWS error to the adapter error codes. REST-JSON services
 * (Bedrock) put the type in the x-amzn-ErrorType header, JSON 1.1
 * services (SageMaker) in the body's __type; SageMaker reports a missing
 * endpoint as a 400 ValidationException whose message says so.
 */
export function classifyAwsError(err: any, fallback: string): never {
  if (err?.code === 'ADAPTER_AUTH' || err?.code === 'ADAPTER_QUOTA_EXCEEDED' || err?.code === 'ADAPTER_NOT_FOUND') throw err;
  const status: number | undefined = err?.response?.status;
  const data = err?.response?.data;
  const headerType = String(err?.response?.headers?.['x-amzn-errortype'] ?? '').split(':')[0];
  const type = headerType || String(data?.__type ?? data?.code ?? '').split('#').pop() || '';
  const message = String(data?.message ?? data?.Message ?? err?.message ?? fallback);

  if (status === 401 || status === 403 || /AccessDenied|UnrecognizedClient|InvalidSignature|ExpiredToken|IncompleteSignature|NotAuthorized|InvalidClientTokenId|MissingAuthenticationToken/i.test(type)) {
    throw Object.assign(new Error(`credential rejected: ${type || status} ${message}`.trim()), { code: 'ADAPTER_AUTH', status: status ?? 403 });
  }
  if (status === 429 || /Throttling|ServiceQuotaExceeded|ResourceLimitExceeded|LimitExceeded/i.test(type) || /quota|limit exceeded|insufficient capacity/i.test(message)) {
    throw Object.assign(new Error(`quota: ${type} ${message}`.trim()), { code: 'ADAPTER_QUOTA_EXCEEDED', status: status ?? 429 });
  }
  if (status === 404 || /ResourceNotFound/i.test(type) || /could not find|does not exist|not found/i.test(message)) {
    throw Object.assign(new Error(`not found: ${message}`), { code: 'ADAPTER_NOT_FOUND', status: status ?? 404 });
  }
  throw Object.assign(new Error(type ? `${type}: ${message}` : message), { code: 'ADAPTER_ERROR', status });
}
