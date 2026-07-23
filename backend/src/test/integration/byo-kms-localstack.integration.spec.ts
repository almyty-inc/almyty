/**
 * REAL BYO-KMS envelope-encryption round-trip against LocalStack KMS (#239).
 *
 * The unit spec (kms/__tests__/envelope-crypto.service.spec.ts) proves the
 * routing/caching logic with a hand-rolled fake KMS that XORs the DEK. That
 * fake can never catch a bug in the actual AWS SDK wiring: wrong command
 * shape, a CiphertextBlob that a real KMS won't accept back, region handling,
 * or an endpoint that never reaches KMS at all. This spec closes that gap by
 * running the SAME EnvelopeCryptoService + KmsClientFactory + KmsProvisioning
 * against a REAL AWS KMS API implementation (LocalStack), exercising genuine
 * KMS Encrypt (DEK wrap) and Decrypt (DEK unwrap) calls over HTTP.
 *
 * It requires:
 *   - RUN_EMULATOR_TESTS=1
 *   - Docker available (a `localstack/localstack` container is started in
 *     beforeAll via testcontainers, exposing the KMS service).
 *
 * The container is torn down in afterAll. When the gate is unset the whole
 * suite is skipped so normal CI is unaffected.
 *
 * Manual equivalent (if you prefer to run LocalStack yourself):
 *   docker run --rm -p 4566:4566 -e SERVICES=kms localstack/localstack:3.8
 *   AWS_KMS_ENDPOINT=http://localhost:4566 \
 *     AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
 *     RUN_EMULATOR_TESTS=1 npx jest byo-kms-localstack
 */
import {
  KMSClient,
  CreateKeyCommand,
} from '@aws-sdk/client-kms';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { EnvelopeCryptoService } from '../../modules/kms/envelope-crypto.service';
import { KmsClientFactory } from '../../modules/kms/kms.service';
import { KmsProvisioningService } from '../../modules/kms/kms-provisioning.service';
import { OrgKmsConfig } from '../../entities/org-kms-config.entity';
import { EE_ENTITLEMENTS } from '../../modules/licensing/license.constants';
import { decryptField } from '../../common/security/field-crypto';

const RUN = process.env.RUN_EMULATOR_TESTS === '1';
const d = RUN ? describe : describe.skip;

const REGION = 'us-east-1';
const ORG_ID = 'org-kms-live-1';
const OTHER_ORG_ID = 'org-kms-live-2';

/** In-memory OrgKmsConfig repo — just enough of the TypeORM surface used. */
class InMemoryKmsConfigRepo {
  rows: OrgKmsConfig[] = [];
  create(partial: Partial<OrgKmsConfig>): OrgKmsConfig {
    return { ...partial } as OrgKmsConfig;
  }
  async findOne({ where }: any): Promise<OrgKmsConfig | null> {
    return (
      this.rows.find((r) =>
        Object.entries(where).every(([k, v]) => (r as any)[k] === v),
      ) ?? null
    );
  }
  async save(entity: OrgKmsConfig): Promise<OrgKmsConfig> {
    const idx = this.rows.findIndex(
      (r) => r.organizationId === entity.organizationId,
    );
    if (idx >= 0) this.rows[idx] = entity;
    else this.rows.push(entity);
    return entity;
  }
}

class FakeOrgLicenseResolver {
  entitled = new Set<string>();
  async hasForOrg(_orgId: string, entitlement: string): Promise<boolean> {
    return this.entitled.has(entitlement);
  }
}

d('BYO-KMS envelope crypto — LocalStack KMS round-trip', () => {
  jest.setTimeout(180_000);

  let container: StartedTestContainer;
  let endpoint: string;
  let cmkArn: string;
  let secondCmkArn: string;
  let repo: InMemoryKmsConfigRepo;
  let resolver: FakeOrgLicenseResolver;
  let factory: KmsClientFactory;
  let provisioning: KmsProvisioningService;
  let envelope: EnvelopeCryptoService;

  beforeAll(async () => {
    // Pin the COMMUNITY image (`latest` now requires a Pro auth token). KMS is
    // a community service in this line. Wait on the health endpoint reporting
    // kms available rather than a log line.
    container = await new GenericContainer('localstack/localstack:3.8')
      .withEnvironment({ SERVICES: 'kms', DEFAULT_REGION: REGION })
      .withExposedPorts(4566)
      .withWaitStrategy(
        Wait.forHttp('/_localstack/health', 4566).forResponsePredicate((body) =>
          /"kms":\s*"(available|running)"/.test(body),
        ),
      )
      .start();

    endpoint = `http://${container.getHost()}:${container.getMappedPort(4566)}`;

    // Point every KMSClient the app builds at LocalStack. Credentials are
    // dummy — LocalStack accepts anything but the SDK requires them present.
    process.env.AWS_KMS_ENDPOINT = endpoint;
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = REGION;

    // Create two REAL CMKs via the AWS SDK against LocalStack.
    const admin = new KMSClient({
      region: REGION,
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const k1 = await admin.send(new CreateKeyCommand({}));
    const k2 = await admin.send(new CreateKeyCommand({}));
    cmkArn = k1.KeyMetadata!.Arn!;
    secondCmkArn = k2.KeyMetadata!.Arn!;
    admin.destroy();

    expect(cmkArn).toMatch(/^arn:aws:kms:/);

    repo = new InMemoryKmsConfigRepo();
    resolver = new FakeOrgLicenseResolver();
    factory = new KmsClientFactory();
    envelope = new EnvelopeCryptoService(repo as any, resolver as any, factory);
    provisioning = new KmsProvisioningService(repo as any, factory, envelope);
  });

  afterAll(async () => {
    delete process.env.AWS_KMS_ENDPOINT;
    if (container) await container.stop();
  });

  it('provisions a CMK by wrapping a fresh DEK via real KMS Encrypt', async () => {
    const view = await provisioning.setCmk(ORG_ID, {
      cmkArn,
      awsRegion: REGION,
      enabled: true,
    });

    expect(view.provisioned).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view.cmkArn).toBe(cmkArn);

    const stored = await repo.findOne({ where: { organizationId: ORG_ID } });
    // The wrapped DEK is real KMS ciphertext (base64) — NOT the raw 32-byte key.
    expect(stored!.wrappedDek).toBeTruthy();
    const wrapped = Buffer.from(stored!.wrappedDek as string, 'base64');
    expect(wrapped.length).toBeGreaterThan(32);
  });

  it('encryptForOrg produces a CMK-wrapped envelope value (not platform-encrypted)', async () => {
    resolver.entitled.add(EE_ENTITLEMENTS.BYO_KMS);

    const plaintext = 'sk-super-secret-provider-key';
    const stored = await envelope.encryptForOrg(ORG_ID, plaintext);

    // Proves the customer-managed path engaged: prefix is `encrypted:kms:`,
    // NOT the platform `encrypted:gcm:` format.
    expect(stored.startsWith('encrypted:kms:')).toBe(true);
    expect(EnvelopeCryptoService.isEnvelope(stored)).toBe(true);
    // Sanity: the platform decrypt path must NOT be able to read a kms value.
    expect(() => decryptField(stored)).toThrow();
  });

  it('round-trips encrypt -> stored -> decrypt through real KMS Decrypt', async () => {
    const plaintext = 'db://user:p@ss@host/db?ssl=true';
    const stored = await envelope.encryptForOrg(ORG_ID, plaintext);
    expect(stored.startsWith('encrypted:kms:')).toBe(true);

    // Drop the cached DEK so decrypt is forced to hit KMS Decrypt again.
    envelope.invalidate(ORG_ID);

    const roundTripped = await envelope.decryptForOrg(ORG_ID, stored);
    expect(roundTripped).toBe(plaintext);
  });

  it('decrypt fails when the org is pointed at the WRONG CMK', async () => {
    // Encrypt under org1's CMK.
    const stored = await envelope.encryptForOrg(ORG_ID, 'secret-under-cmk1');
    expect(stored.startsWith('encrypted:kms:')).toBe(true);

    // Provision a DIFFERENT org with a DIFFERENT CMK, then try to decrypt
    // org1's value using org2's DEK. The GCM auth tag must reject it.
    resolver.entitled.add(EE_ENTITLEMENTS.BYO_KMS);
    await provisioning.setCmk(OTHER_ORG_ID, {
      cmkArn: secondCmkArn,
      awsRegion: REGION,
      enabled: true,
    });

    await expect(
      envelope.decryptForOrg(OTHER_ORG_ID, stored),
    ).rejects.toThrow();
  });

  it('non-envelope (platform) values still decrypt after warmOrg — no KMS needed', async () => {
    // An org with NO entitlement encrypts via the platform path.
    const bareResolver = new FakeOrgLicenseResolver();
    const bareEnvelope = new EnvelopeCryptoService(
      repo as any,
      bareResolver as any,
      factory,
    );
    const stored = await bareEnvelope.encryptForOrg('org-no-kms', 'plain-secret');
    expect(stored.startsWith('encrypted:kms:')).toBe(false);
    const back = await bareEnvelope.decryptForOrg('org-no-kms', stored);
    expect(back).toBe('plain-secret');
  });
});
