import { readFileSync } from 'fs';
import { join } from 'path';

import { Credential, CredentialType } from '../../../entities/credential.entity';
import { ModelRegistryService } from '../model-registry.service';

/**
 * The registry connection's `endpoint` is a string an org admin typed
 * into a credential, and this pod builds an S3Client on it and sends
 * requests. Pointed at `http://169.254.169.254` or a cluster-internal
 * address, `POST /model-versions` becomes an outbound probe from inside
 * the network — and the manifest read hands the failure back verbatim
 * (`Cannot read the manifest at ...: <message>`), which distinguishes a
 * refused connection from a timeout: an open-port oracle, the thing
 * `common/security/safe-fetch.ts` documents itself as existing to stop.
 *
 * The same field is already refused by the connection validator
 * (connection-validation.service.ts, s3Bucket), but that only runs on the
 * opt-in `POST /credentials/:id/test`, and nothing requires a connection
 * to have been tested before it is used.
 */
function credentialWith(endpoint: string | undefined): Credential {
  const c = new Credential();
  c.id = 'cred-1';
  c.organizationId = 'org-1';
  c.type = CredentialType.S3_COMPATIBLE;
  c.isActive = true;
  (c as any).getDecryptedConfig = () => ({
    bucket: 'weights',
    region: 'us-east-1',
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
    ...(endpoint ? { endpoint } : {}),
  });
  return c;
}

function serviceWith(credential: Credential): ModelRegistryService {
  const credentials = { findOne: jest.fn(async () => credential) };
  return new ModelRegistryService(undefined, undefined, credentials as any, undefined, undefined);
}

describe('the registry connection endpoint is gated before any request is made', () => {
  it('refuses the cloud metadata address', async () => {
    const service = serviceWith(credentialWith('http://169.254.169.254'));
    await expect(service.connectionFor('org-1')).rejects.toMatchObject({ code: 'REGISTRY_ENDPOINT_REFUSED' });
  });

  it('refuses loopback', async () => {
    const service = serviceWith(credentialWith('http://127.0.0.1:9000'));
    await expect(service.connectionFor('org-1')).rejects.toMatchObject({ code: 'REGISTRY_ENDPOINT_REFUSED' });
  });

  it('refuses a private address', async () => {
    const service = serviceWith(credentialWith('http://10.0.0.5:9000'));
    await expect(service.connectionFor('org-1')).rejects.toMatchObject({ code: 'REGISTRY_ENDPOINT_REFUSED' });
  });

  it('allows an ordinary public endpoint', async () => {
    const service = serviceWith(credentialWith('https://s3.eu-central-1.amazonaws.com'));
    await expect(service.connectionFor('org-1')).resolves.toMatchObject({ bucket: 'weights' });
  });

  it('allows a connection with no endpoint at all', async () => {
    const service = serviceWith(credentialWith(undefined));
    await expect(service.connectionFor('org-1')).resolves.toMatchObject({ bucket: 'weights', endpoint: undefined });
  });
});

/**
 * Source-reading guard: the gate has to sit in `connectionFor`, which
 * every read, write and adapter-credential path goes through. Gating one
 * caller leaves the others open.
 */
describe('guard: the gate is on the one resolution path', () => {
  const source = readFileSync(join(__dirname, '..', 'model-registry.service.ts'), 'utf8');

  it('validates the endpoint inside connectionFor', () => {
    const fn = source.slice(source.indexOf('async connectionFor('), source.indexOf('async isConnected('));
    expect(fn).toMatch(/validateUrl\(String\(cfg\.endpoint\)\)/);
    expect(fn).toContain('REGISTRY_ENDPOINT_REFUSED');
  });

  it('resolves the adapter credentials through connectionFor rather than reading the credential again', () => {
    const fn = source.slice(source.indexOf('async adapterCredentialsFor('), source.indexOf('private resolveOverride('));
    expect(fn).toContain('await this.connectionFor(organizationId)');
  });
});
