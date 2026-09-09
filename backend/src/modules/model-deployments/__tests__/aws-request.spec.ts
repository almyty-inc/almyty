import { createHash, createHmac } from 'crypto';

import { accessKeyOf, classifyAwsError, signAwsRequest } from '../aws-request';

/**
 * The hand-rolled SigV4 signer is checked against @smithy/signature-v4,
 * the AWS SDK's own signer, which is present transitively but not a
 * dependency the adapters may import at runtime.
 */
class NodeSha256 {
  private h: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(secret?: string | Uint8Array) {
    this.h = secret ? createHmac('sha256', secret as any) : createHash('sha256');
  }
  update(data: any): void {
    this.h.update(data);
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.h.digest());
  }
}

async function smithySign(input: { method: string; url: string; service: string; region: string; headers?: Record<string, string>; body?: string; credentials: any; now: Date }) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SignatureV4 } = require('@smithy/signature-v4');
  const url = new URL(input.url);
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;
  const signer = new SignatureV4({ credentials: input.credentials, region: input.region, service: input.service, sha256: NodeSha256, applyChecksum: false });
  const signed = await signer.sign(
    { method: input.method, protocol: 'https:', hostname: url.hostname, path: url.pathname, query, headers: { host: url.host, ...(input.headers ?? {}) }, body: input.body },
    { signingDate: input.now },
  );
  return signed.headers as Record<string, string>;
}

describe('aws-request: SigV4 signer', () => {
  const credentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
  const now = new Date('2026-09-08T10:00:00Z');

  it.each([
    ['bedrock REST-JSON POST', { method: 'POST' as const, url: 'https://bedrock.us-east-1.amazonaws.com/model-import-jobs', service: 'bedrock', region: 'us-east-1', headers: { 'content-type': 'application/json' }, body: '{"jobName":"x"}' }],
    ['bedrock GET with an encoded path segment and a query', { method: 'GET' as const, url: 'https://bedrock.eu-central-1.amazonaws.com/model-import-jobs/almyty-abc%3Ajob?maxResults=5&sortBy=CreationTime', service: 'bedrock', region: 'eu-central-1' }],
    ['sagemaker JSON 1.1 with X-Amz-Target', { method: 'POST' as const, url: 'https://api.sagemaker.us-west-2.amazonaws.com/', service: 'sagemaker', region: 'us-west-2', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'SageMaker.DescribeEndpoint' }, body: '{"EndpointName":"almyty-1"}' }],
  ])('matches the AWS SDK signer: %s', async (_name, input) => {
    const ours = signAwsRequest({ ...input, credentials, now });
    const theirs = await smithySign({ ...input, credentials, now });
    expect(ours.headers.authorization).toBe(theirs.authorization);
    expect(ours.headers['x-amz-date']).toBe(theirs['x-amz-date']);
  });

  it('signs the session token header for temporary credentials', async () => {
    const temp = { ...credentials, sessionToken: 'FQoGZXIvYXdzEBYaDExample' };
    const input = { method: 'POST' as const, url: 'https://bedrock.us-east-1.amazonaws.com/model-import-jobs', service: 'bedrock', region: 'us-east-1', headers: { 'content-type': 'application/json' }, body: '{}' };
    const ours = signAwsRequest({ ...input, credentials: temp, now });
    const theirs = await smithySign({ ...input, credentials: temp, now });
    expect(ours.headers['x-amz-security-token']).toBe(temp.sessionToken);
    expect(ours.headers.authorization).toBe(theirs.authorization);
    expect(ours.headers.authorization).toContain('x-amz-security-token');
  });

  it('exposes the access key from the Credential scope for fixtures', () => {
    const signed = signAwsRequest({ method: 'GET', url: 'https://bedrock.us-east-1.amazonaws.com/imported-models/x', service: 'bedrock', region: 'us-east-1', credentials, now });
    expect(accessKeyOf(signed.headers.authorization)).toBe('AKIAEXAMPLE');
    expect(accessKeyOf(undefined)).toBeUndefined();
  });
});

describe('aws-request: error classification', () => {
  const rest = (status: number, type: string, message: string) => ({ response: { status, data: { message }, headers: { 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/` } } });
  const json11 = (status: number, type: string, message: string) => ({ response: { status, data: { __type: `com.amazon.coral.service#${type}`, message } } });

  it.each([
    ['bedrock 403 AccessDenied', rest(403, 'AccessDeniedException', 'denied'), 'ADAPTER_AUTH'],
    ['sagemaker bad key', json11(403, 'UnrecognizedClientException', 'The security token included in the request is invalid.'), 'ADAPTER_AUTH'],
    ['sagemaker expired token', json11(403, 'ExpiredTokenException', 'expired'), 'ADAPTER_AUTH'],
    ['bedrock 400 ServiceQuotaExceeded', rest(400, 'ServiceQuotaExceededException', 'too many'), 'ADAPTER_QUOTA_EXCEEDED'],
    ['bedrock 429 Throttling', rest(429, 'ThrottlingException', 'slow down'), 'ADAPTER_QUOTA_EXCEEDED'],
    ['sagemaker ResourceLimitExceeded', json11(400, 'ResourceLimitExceeded', 'The account-level service limit ml.p5.48xlarge for endpoint usage is 0 Instances'), 'ADAPTER_QUOTA_EXCEEDED'],
    ['bedrock 404', rest(404, 'ResourceNotFoundException', 'nope'), 'ADAPTER_NOT_FOUND'],
    ['sagemaker missing endpoint (400 ValidationException)', json11(400, 'ValidationException', 'Could not find endpoint "arn:aws:sagemaker:us-east-1:1:endpoint/x".'), 'ADAPTER_NOT_FOUND'],
    ['bedrock 400 ValidationException', rest(400, 'ValidationException', 'bad input'), 'ADAPTER_ERROR'],
    ['network error', new Error('ECONNRESET'), 'ADAPTER_ERROR'],
  ])('%s -> %s', (_name, err, code) => {
    expect(() => classifyAwsError(err, 'fallback')).toThrow(expect.objectContaining({ code }));
  });

  it('passes an already typed error through', () => {
    const typed = Object.assign(new Error('x'), { code: 'ADAPTER_AUTH' });
    expect(() => classifyAwsError(typed, 'fallback')).toThrow(typed);
  });
});
