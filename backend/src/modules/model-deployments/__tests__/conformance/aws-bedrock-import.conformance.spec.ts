import { AwsBedrockImportAdapter } from '../../adapters/aws-bedrock-import.adapter';
import { accessKeyOf } from '../../aws-request';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: an in-memory stand-in for the Bedrock control plane,
 * faithful to the documented paths (POST /model-import-jobs,
 * GET /model-import-jobs/{id}, GET|DELETE /imported-models/{id}), job
 * states (InProgress|Completed|Failed), the REST-JSON error envelope
 * (x-amzn-ErrorType header + {message}) and status codes. Live mode
 * (CONFORMANCE_LIVE=aws-bedrock-import with AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_REGION, BEDROCK_IMPORT_ROLE_ARN and
 * BEDROCK_TEST_S3_URI pointing at HF-format weights) runs the same cases
 * against a real account; never in CI.
 */
function fixtureHttp() {
  const jobs = new Map<string, any>();
  const models = new Map<string, any>();
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: any }> = [];
  const awsError = (status: number, type: string, message: string) =>
    Object.assign(new Error(`${status}`), { response: { status, data: { message }, headers: { 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/` } } });
  const http = {
    request: jest.fn(async (config: { method: string; url: string; headers: Record<string, string>; data?: string }) => {
      const body = config.data ? JSON.parse(config.data) : undefined;
      calls.push({ method: config.method, url: config.url, headers: config.headers, body });
      if (accessKeyOf(config.headers.authorization) !== 'AKIAVALID') {
        throw awsError(403, 'UnrecognizedClientException', 'The security token included in the request is invalid.');
      }
      const url = new URL(config.url);
      const region = url.hostname.split('.')[1];
      const m = url.pathname.match(/^\/(model-import-jobs|imported-models)(?:\/([^/]+))?$/);
      const [, collection, id] = m ?? [];

      if (config.method === 'POST' && collection === 'model-import-jobs' && !id) {
        if (body.roleArn.endsWith('role/quota')) throw awsError(400, 'ServiceQuotaExceededException', 'The number of imported models exceeds the service quota.');
        const jobArn = `arn:aws:bedrock:${region}:111122223333:model-import-job/${Math.random().toString(36).slice(2, 14)}`;
        jobs.set(body.jobName, { ...body, jobArn, status: 'InProgress', region });
        return { status: 201, data: { jobArn } };
      }
      if (config.method === 'GET' && collection === 'model-import-jobs' && id) {
        const job = jobs.get(decodeURIComponent(id));
        if (!job) throw awsError(404, 'ResourceNotFoundException', 'Could not find job');
        // The fixture completes the import on the first read after creation.
        if (job.status === 'InProgress' && !job.failNext && !models.has(job.importedModelName)) {
          const modelArn = `arn:aws:bedrock:${job.region}:111122223333:imported-model/${Math.random().toString(36).slice(2, 14)}`;
          job.status = 'Completed';
          job.importedModelArn = modelArn;
          models.set(job.importedModelName, { modelArn, modelName: job.importedModelName, jobArn: job.jobArn, modelArchitecture: 'qwen3', instructSupported: true, customModelUnits: { customModelUnitsPerModelCopy: 1, customModelUnitsVersion: 'v2.0' } });
        }
        return { status: 200, data: { ...job } };
      }
      if (config.method === 'GET' && collection === 'imported-models' && id) {
        const model = models.get(decodeURIComponent(id));
        if (!model) throw awsError(404, 'ResourceNotFoundException', 'Could not find imported model');
        return { status: 200, data: { ...model } };
      }
      if (config.method === 'DELETE' && collection === 'imported-models' && id) {
        if (!models.delete(decodeURIComponent(id))) throw awsError(404, 'ResourceNotFoundException', 'Could not find imported model');
        return { status: 200, data: '' };
      }
      throw new Error(`unexpected request ${config.method} ${config.url}`);
    }),
  };
  return { jobs, models, calls, http };
}

const live = liveRequested('aws-bedrock-import');
const fixture = fixtureHttp();
const adapter = () => (live ? new AwsBedrockImportAdapter() : new AwsBedrockImportAdapter(fixture.http));
const liveCreds = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
const tiny = {
  id: 'v1',
  name: 'qwen3-0.6b',
  registryUri: live ? `${process.env.BEDROCK_TEST_S3_URI}@live` : 's3://registry/models/qwen3-0.6b@etag1',
  base: 'qwen3-0.6b',
  quantizations: [],
  manifestSha: 'sha',
};
const config = { region: live ? process.env.AWS_REGION ?? 'us-east-1' : 'us-east-1', roleArn: live ? process.env.BEDROCK_IMPORT_ROLE_ARN : 'arn:aws:iam::111122223333:role/bedrock-import', hourlyRateCents: 240 };

runConformance(live ? 'aws-bedrock-import (LIVE)' : 'aws-bedrock-import (fixture)', {
  adapter,
  credentials: live ? liveCreds : { accessKeyId: 'AKIAVALID', secretAccessKey: 'secret' },
  badCredentials: { accessKeyId: 'AKIAEXPIRED', secretAccessKey: 'secret' },
  tinyVersion: tiny,
  providerConfig: config,
  unsupportedArchitectureVersion: { id: 'v2', name: 'mamba', registryUri: 's3://registry/models/mamba@etag2', base: 'mamba-2.8b', quantizations: [], manifestSha: 'sha' },
  quotaExceededConfig: live ? undefined : { ...config, roleArn: 'arn:aws:iam::111122223333:role/quota' },
  // A model can only vanish once the import has completed; the first read completes it in the fixture.
  vanish: live ? undefined : async (a, ref) => { await a.readEndpoint(ref, { accessKeyId: 'AKIAVALID', secretAccessKey: 'secret' }); fixture.models.delete(ref.importedModelName); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 45 * 60_000 : 5_000,
});

describe('aws-bedrock-import request shape', () => {
  const creds = { accessKeyId: 'AKIAVALID', secretAccessKey: 'secret', sessionToken: 'tok' };
  const request = (overrides: Partial<Parameters<AwsBedrockImportAdapter['deploy']>[0]> = {}) => ({
    deploymentId: 'abc-123',
    organizationId: 'org-1',
    version: { id: 'v', name: 'q', registryUri: 's3://registry/models/q@etag', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' },
    desired: { replicas: 1, region: 'eu-central-1' },
    providerConfig: { region: 'us-east-1', roleArn: 'arn:aws:iam::111122223333:role/bedrock-import', kmsKeyId: 'alias/almyty', hourlyRateCents: 240 },
    ...overrides,
  });

  it('creates one import job from the S3 registry prefix, signed for the requested region', async () => {
    const f = fixtureHttp();
    const a = new AwsBedrockImportAdapter(f.http);
    const ref = await a.deploy(request(), creds);
    const call = f.calls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://bedrock.eu-central-1.amazonaws.com/model-import-jobs');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAVALID\/\d{8}\/eu-central-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(call.headers['x-amz-security-token']).toBe('tok');
    expect(call.body.importedModelName).toBe('almyty-abc123');
    expect(call.body.jobName).toMatch(/^almyty-abc123-[a-z0-9]+$/);
    expect(call.body.roleArn).toBe('arn:aws:iam::111122223333:role/bedrock-import');
    expect(call.body.modelDataSource).toEqual({ s3DataSource: { s3Uri: 's3://registry/models/q' } });
    expect(call.body.importedModelKmsKeyId).toBe('alias/almyty');
    expect(call.body.clientRequestToken).toMatch(/^[a-zA-Z0-9][-a-zA-Z0-9]*[a-zA-Z0-9]$/);
    expect(call.body.importedModelTags).toEqual([{ key: 'almyty:deployment', value: 'abc-123' }, { key: 'almyty:organization', value: 'org-1' }]);
    expect(call.body.vpcConfig).toBeUndefined();
    expect(JSON.stringify(call.body)).not.toContain('secret');
    expect(ref).toMatchObject({ importedModelName: 'almyty-abc123', region: 'eu-central-1', hourlyRateCents: 240, maxCopies: 1 });
    expect(ref.jobArn).toMatch(/^arn:aws:bedrock:eu-central-1:/);
  });

  it('passes a VPC configuration through when subnets are configured', async () => {
    const f = fixtureHttp();
    const a = new AwsBedrockImportAdapter(f.http);
    await a.deploy(request({ providerConfig: { region: 'us-east-1', roleArn: 'arn:aws:iam::111122223333:role/r', vpcSubnetIds: ['subnet-1'], vpcSecurityGroupIds: ['sg-1'] } }), creds);
    expect(f.calls[0].body.vpcConfig).toEqual({ subnetIds: ['subnet-1'], securityGroupIds: ['sg-1'] });
  });

  it('refuses a non-S3 registry source before calling AWS', async () => {
    const f = fixtureHttp();
    const a = new AwsBedrockImportAdapter(f.http);
    await expect(a.deploy(request({ version: { id: 'v', name: 'q', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 's' } }), creds)).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_OPERATION' });
    expect(f.calls).toHaveLength(0);
  });

  it('reads the job by name, then the imported model, and exposes the runtime invoke URL with the model ARN', async () => {
    const f = fixtureHttp();
    const a = new AwsBedrockImportAdapter(f.http);
    const ref = await a.deploy(request(), creds);
    const actual = await a.readEndpoint(ref, creds);
    expect(f.calls[1].url).toBe(`https://bedrock.eu-central-1.amazonaws.com/model-import-jobs/${ref.jobName}`);
    expect(f.calls[2].url).toBe('https://bedrock.eu-central-1.amazonaws.com/imported-models/almyty-abc123');
    expect(actual.state).toBe('ready');
    expect(actual.url).toBe(`https://bedrock-runtime.eu-central-1.amazonaws.com/model/${encodeURIComponent(actual.details!.modelArn)}/invoke`);
    expect(actual.details).toMatchObject({ modelArchitecture: 'qwen3', customModelUnitsPerCopy: 1, customModelUnitsVersion: 'v2.0' });
    expect(ref.importedModelArn).toBe(actual.details!.modelArn);
  });

  it('maps every documented job status and a failed import carries the failure message', async () => {
    const f = fixtureHttp();
    const a = new AwsBedrockImportAdapter(f.http);
    const ref = await a.deploy(request(), creds);
    const job = f.jobs.get(ref.jobName);
    job.failNext = true;
    expect((await a.readEndpoint(ref, creds)).state).toBe('deploying');
    job.status = 'Failed';
    job.failureMessage = 'Unsupported model architecture: mamba';
    const failed = await a.readEndpoint(ref, creds);
    expect(failed.state).toBe('failed');
    expect(failed.message).toBe('Unsupported model architecture: mamba');
    job.status = 'Completed';
    job.failNext = false;
    f.models.set('almyty-abc123', { modelArn: 'arn:aws:bedrock:eu-central-1:111122223333:imported-model/abcdefghijkl' });
    expect((await a.readEndpoint(ref, creds)).state).toBe('ready');
  });

  it('treats standby (scale to zero) as stopped with no burn, and teardown deletes the imported model by name', async () => {
    const f = fixtureHttp();
    const a = new AwsBedrockImportAdapter(f.http);
    const ref = await a.deploy(request(), creds);
    await a.readEndpoint(ref, creds);
    await a.scale(ref, 0, creds);
    const standby = await a.readEndpoint(ref, creds);
    expect(standby.state).toBe('stopped');
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(0);
    await a.scale(ref, 1, creds);
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(240);
    await a.teardown(ref, creds);
    const del = f.calls[f.calls.length - 1];
    expect(del.method).toBe('DELETE');
    expect(del.url).toBe('https://bedrock.eu-central-1.amazonaws.com/imported-models/almyty-abc123');
    await expect(a.teardown(ref, creds)).resolves.toBeUndefined();
  });
});
