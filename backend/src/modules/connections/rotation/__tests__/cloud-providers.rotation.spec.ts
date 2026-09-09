import { generateKeyPairSync } from 'crypto';

import { accessKeyOf } from '../../../model-deployments/aws-request';
import { AwsRotation } from '../providers/aws.rotation';
import { AzureRotation } from '../providers/azure.rotation';
import { GcpRotation } from '../providers/gcp.rotation';
import { ctx, fixtureHttp, rejection } from './rotation-support';

describe('AwsRotation', () => {
  const secrets = { accessKeyId: 'AKIAOLDOLDOLDOLDOLD1', secretAccessKey: 'oldsecretoldsecretoldsecret', region: 'eu-west-1' };
  const iam = (json: unknown, status = 200) => ({ method: 'POST', url: 'https://iam.amazonaws.com/', handle: () => ({ status, body: json }) });

  it('signs CreateAccessKey for iam in us-east-1 with the 2010-05-08 query API and drops any session token', async () => {
    const f = fixtureHttp([iam({ CreateAccessKeyResponse: { CreateAccessKeyResult: { AccessKey: { AccessKeyId: 'AKIANEWNEWNEWNEWNEW1', SecretAccessKey: 'newsecret', Status: 'Active', UserName: 'bob', CreateDate: 1757332800 } } } })]);
    const out = await new AwsRotation(f.http).rotate({ ...secrets, sessionToken: 'stale' }, ctx);
    expect(out).toEqual({ next: { accessKeyId: 'AKIANEWNEWNEWNEWNEW1', secretAccessKey: 'newsecret', sessionToken: '' }, label: 'bob NEW1' });
    const call = f.calls[0];
    expect(call.body).toBe('Action=CreateAccessKey&Version=2010-05-08');
    expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAOLDOLDOLDOLDOLD1\/20260908\/us-east-1\/iam\/aws4_request, SignedHeaders=/);
    expect(call.headers['x-amz-security-token']).toBe('stale');
    expect(call.headers.accept).toBe('application/json');
  });

  it('passes an explicit IAM user name through and signs the delete with the successor', async () => {
    const f = fixtureHttp([iam({ DeleteAccessKeyResponse: { ResponseMetadata: { RequestId: 'r' } } })]);
    await new AwsRotation(f.http).revoke({ ...secrets, iamUserName: 'bob' }, { ...ctx, successor: { accessKeyId: 'AKIANEWNEWNEWNEWNEW1', secretAccessKey: 'newsecret' } });
    expect(f.calls[0].body).toBe('Action=DeleteAccessKey&Version=2010-05-08&AccessKeyId=AKIAOLDOLDOLDOLDOLD1&UserName=bob');
    expect(accessKeyOf(f.calls[0].headers.authorization)).toBe('AKIANEWNEWNEWNEWNEW1');
  });

  it('describes from GetAccessKeyLastUsed and ListAccessKeys, reading JSON or XML', async () => {
    let n = 0;
    const f = fixtureHttp([{ method: 'POST', url: 'https://iam.amazonaws.com/', handle: () => (n++ === 0
      ? { status: 200, body: { GetAccessKeyLastUsedResponse: { GetAccessKeyLastUsedResult: { AccessKeyLastUsed: { LastUsedDate: 1757000000, Region: 'us-west-2', ServiceName: 's3' }, UserName: 'bob' } } } }
      : { status: 200, body: '<ListAccessKeysResponse><ListAccessKeysResult><AccessKeyMetadata><member><AccessKeyId>AKIAOLDOLDOLDOLDOLD1</AccessKeyId><Status>Active</Status><CreateDate>2026-01-01T00:00:00Z</CreateDate></member></AccessKeyMetadata></ListAccessKeysResult></ListAccessKeysResponse>', headers: { 'content-type': 'text/xml' } }) }]);
    const d = await new AwsRotation(f.http).describe(secrets, ctx);
    expect(d).toEqual({ label: 'bob OLD1', createdAt: new Date('2026-01-01T00:00:00Z'), lastUsedAt: new Date(1757000000 * 1000) });
    expect(f.calls.map((c) => c.body)).toEqual(['Action=GetAccessKeyLastUsed&Version=2010-05-08&AccessKeyId=AKIAOLDOLDOLDOLDOLD1', 'Action=ListAccessKeys&Version=2010-05-08']);
  });

  it('maps AccessDenied to ROTATION_AUTH, LimitExceeded to a ROTATION_FAILED hint, and a role-only connection to ROTATION_UNSUPPORTED', async () => {
    const denied = fixtureHttp([iam({ Error: { Code: 'AccessDenied', Message: 'not authorized to perform iam:CreateAccessKey' } }, 403)]);
    const e1 = await rejection(new AwsRotation(denied.http).rotate(secrets, ctx));
    expect(e1.code).toBe('ROTATION_AUTH');
    expect(e1.message).toContain('iam:CreateAccessKey');
    expect(e1.message).not.toContain('oldsecret');
    const limited = fixtureHttp([iam({ Error: { Code: 'LimitExceeded', Message: 'Cannot exceed quota for AccessKeysPerUser: 2' } }, 409)]);
    const e2 = await rejection(new AwsRotation(limited.http).rotate(secrets, ctx));
    expect(e2.code).toBe('ROTATION_FAILED');
    expect(e2.message).toContain('two access keys');
    const role = fixtureHttp([]);
    expect((await rejection(new AwsRotation(role.http).rotate({ roleArn: 'arn:aws:iam::123456789012:role/x' }, ctx))).code).toBe('ROTATION_UNSUPPORTED');
  });
});

describe('GcpRotation', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyFile = (id: string) => JSON.stringify({ type: 'service_account', project_id: 'proj-1', private_key_id: id, private_key: pem, client_email: 'svc@proj-1.iam.gserviceaccount.com', token_uri: 'https://evil.example/token' });
  const secrets = { serviceAccountJson: keyFile('oldkeyid') };
  const token = { method: 'POST', url: 'https://oauth2.googleapis.com/token', handle: () => ({ status: 200, body: { access_token: 'ya29.tok', expires_in: 3600 } }) };
  const base = 'https://iam.googleapis.com/v1/projects/proj-1/serviceAccounts/svc%40proj-1.iam.gserviceaccount.com/keys';

  it('exchanges a signed JWT at the fixed token URL, creates a credentials-file key and decodes it', async () => {
    const newFile = keyFile('newkeyid');
    const f = fixtureHttp([token, { method: 'POST', url: base, handle: () => ({ status: 200, body: { name: `projects/proj-1/serviceAccounts/svc@proj-1.iam.gserviceaccount.com/keys/newkeyid`, privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', privateKeyData: Buffer.from(newFile).toString('base64'), validAfterTime: '2026-09-08T12:00:00Z', validBeforeTime: '9999-12-31T23:59:59Z' } }) }]);
    const out = await new GcpRotation(f.http).rotate(secrets, ctx);
    expect(out).toEqual({ next: { serviceAccountJson: newFile }, label: 'svc@proj-1.iam.gserviceaccount.com newkeyid', expiresAt: undefined });
    expect(f.calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(f.calls[0].body).toMatch(/^grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
    expect(f.calls[1].headers.authorization).toBe('Bearer ya29.tok');
    expect(f.calls[1].json).toEqual({ privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' });
  });

  it('deletes the old key by private_key_id, authenticating with the successor file, and describes validity', async () => {
    const f = fixtureHttp([
      token,
      { method: 'DELETE', url: `${base}/oldkeyid`, handle: () => ({ status: 200, body: {} }) },
      { method: 'GET', url: `${base}/oldkeyid`, handle: () => ({ status: 200, body: { validAfterTime: '2026-01-01T00:00:00Z', validBeforeTime: '2027-01-01T00:00:00Z', disabled: false } }) },
    ]);
    const p = new GcpRotation(f.http);
    await p.revoke(secrets, { ...ctx, successor: { serviceAccountJson: keyFile('newkeyid') } });
    expect(f.calls[1].method).toBe('DELETE');
    expect(f.calls[1].url).toBe(`${base}/oldkeyid`);
    const jwtHeader = JSON.parse(Buffer.from(decodeURIComponent(f.calls[0].body!.split('assertion=')[1]).split('.')[0], 'base64url').toString());
    expect(jwtHeader.kid).toBe('newkeyid');
    expect(await p.describe(secrets, ctx)).toEqual({ label: 'svc@proj-1.iam.gserviceaccount.com oldkeyid', createdAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2027-01-01T00:00:00Z') });
  });

  it('maps a refused token exchange to ROTATION_AUTH, a 403 on the IAM call to ROTATION_AUTH, and a bad key file to ROTATION_FAILED', async () => {
    const refused = fixtureHttp([{ method: 'POST', url: 'https://oauth2.googleapis.com/token', handle: () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }) }]);
    const e1 = await rejection(new GcpRotation(refused.http).rotate(secrets, ctx));
    expect(e1.code).toBe('ROTATION_AUTH');
    expect(e1.message).toContain('Invalid JWT Signature');
    const denied = fixtureHttp([token, { method: 'POST', url: base, handle: () => ({ status: 403, body: { error: { code: 403, message: 'Permission iam.serviceAccountKeys.create denied', status: 'PERMISSION_DENIED' } } }) }]);
    expect((await rejection(new GcpRotation(denied.http).rotate(secrets, ctx))).code).toBe('ROTATION_AUTH');
    expect((await rejection(new GcpRotation(fixtureHttp([]).http).rotate({ serviceAccountJson: '{"type":"user"}' }, ctx))).code).toBe('ROTATION_FAILED');
  });
});

describe('AzureRotation', () => {
  const secrets = { tenantId: 'contoso.onmicrosoft.com', clientId: 'app-1234', clientSecret: 'Abc~oldsecret' };
  const token = { method: 'POST', url: 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token', handle: () => ({ status: 200, body: { access_token: 'eyJ.graph', expires_in: 3599 } }) };
  const app = "https://graph.microsoft.com/v1.0/applications(appId='app-1234')";

  it('gets a Graph token by client credentials and adds a password, keeping its keyId and expiry', async () => {
    const f = fixtureHttp([token, { method: 'POST', url: `${app}/addPassword`, handle: () => ({ status: 200, body: { keyId: 'kid-new', secretText: 'Xyz~newsecret', hint: 'Xyz', displayName: 'almyty conn-123 2026-09-08', startDateTime: '2026-09-08T12:00:00Z', endDateTime: '2028-09-08T12:00:00Z' } }) }]);
    const out = await new AzureRotation(f.http).rotate(secrets, ctx);
    expect(out).toEqual({ next: { clientSecret: 'Xyz~newsecret', secretKeyId: 'kid-new' }, label: 'almyty conn-123 2026-09-08', expiresAt: new Date('2028-09-08T12:00:00Z') });
    expect(f.calls[0].body).toBe('grant_type=client_credentials&client_id=app-1234&client_secret=Abc%7Eoldsecret&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default');
    expect(f.calls[1].headers.authorization).toBe('Bearer eyJ.graph');
    expect(f.calls[1].json).toEqual({ passwordCredential: { displayName: 'almyty conn-123 2026-09-08' } });
  });

  it('removes by stored keyId with the successor secret, or finds the credential by hint, and describes it', async () => {
    const f = fixtureHttp([
      token,
      { method: 'POST', url: `${app}/removePassword`, handle: () => ({ status: 204 }) },
      { method: 'GET', url: `${app}?$select=id,passwordCredentials`, handle: () => ({ status: 200, body: { id: 'obj-1', passwordCredentials: [{ keyId: 'kid-x', hint: 'Zzz', displayName: 'other' }, { keyId: 'kid-old', hint: 'Abc', displayName: 'legacy', startDateTime: '2026-01-01T00:00:00Z', endDateTime: '2027-01-01T00:00:00Z' }] } }) },
    ]);
    const p = new AzureRotation(f.http);
    await p.revoke({ ...secrets, secretKeyId: 'kid-stored' }, { ...ctx, successor: { clientSecret: 'Xyz~newsecret' } });
    expect(f.calls[0].body).toContain('client_secret=Xyz%7Enewsecret');
    expect(f.calls[1].json).toEqual({ keyId: 'kid-stored' });
    f.calls.length = 0;
    await p.revoke(secrets, ctx);
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token`, `GET ${app}?$select=id,passwordCredentials`, `POST ${app}/removePassword`]);
    expect(f.calls[2].json).toEqual({ keyId: 'kid-old' });
    expect(await p.describe(secrets)).toEqual({ label: 'legacy', createdAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2027-01-01T00:00:00Z') });
  });

  it('maps a rejected client secret to ROTATION_AUTH and refuses a tenant id that is not a host segment', async () => {
    const f = fixtureHttp([{ method: 'POST', url: 'https://login.microsoftonline.com/', handle: () => ({ status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' } }) }]);
    const e = await rejection(new AzureRotation(f.http).describe(secrets));
    expect(e.code).toBe('ROTATION_AUTH');
    expect(e.message).toContain('AADSTS7000215');
    expect(e.message).not.toContain('oldsecret');
    const g = fixtureHttp([]);
    expect((await rejection(new AzureRotation(g.http).rotate({ ...secrets, tenantId: 'x/../y' }, ctx))).code).toBe('ROTATION_FAILED');
    expect(g.calls).toHaveLength(0);
  });
});
