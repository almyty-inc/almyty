import { EnvelopeCryptoService, keyIdOf } from '../envelope-crypto.service';
import { KmsProvisioningService } from '../kms-provisioning.service';
import { KmsClientFactory, KmsKeyRef } from '../kms.service';
import { OrgKmsConfig } from '../../../entities/org-kms-config.entity';
import { EE_ENTITLEMENTS } from '../../licensing/license.constants';
import { registerEnvelopeUnwrapHook } from '../../../common/security/field-crypto';
import { Credential, CredentialType } from '../../../entities/credential.entity';

/**
 * A CMK rotation must not cost the org its secrets.
 *
 * A rotation mints a new DEK. Everything already sealed was sealed under the
 * previous one, so unless a value can say WHICH key sealed it — and unless that
 * key's wrapped blob is still around — a rotation silently makes every existing
 * customer-managed secret unreadable: the DEK the config now holds is not the
 * one the value was sealed with, and AES-GCM refuses the tag.
 *
 * These specs drive the real provisioning service and the real crypto service
 * against a deterministic fake KMS, so attach -> seal -> rotate -> read is
 * exercised through exactly the code the admin API calls.
 */

const CMK_A =
  'arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-1111-2222-3333-444444444444';
const CMK_B =
  'arn:aws:kms:us-east-1:123456789012:key/bbbbbbbb-1111-2222-3333-444444444444';
const CMK_C =
  'arn:aws:kms:us-east-1:123456789012:key/cccccccc-1111-2222-3333-444444444444';

/**
 * Deterministic stand-in for AWS KMS: `encrypt` marks the blob and XORs the DEK
 * with a stream derived from the CMK ARN, `decrypt` reverses it. Because the
 * stream depends on the ARN, unwrapping a blob with the WRONG CMK yields a
 * wrong key rather than an error — which is what makes these specs able to
 * catch a retired DEK being unwrapped under the org's current CMK instead of
 * the one that wrapped it.
 */
class FakeKms {
  encryptCalls: Array<{ ref: KmsKeyRef }> = [];
  decryptCalls: Array<{ ref: KmsKeyRef }> = [];

  private mask(keyArn: string, buf: Buffer): Buffer {
    const seed = Buffer.from(keyArn);
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ seed[i % seed.length];
    return out;
  }

  async encrypt(ref: KmsKeyRef, plaintext: Buffer): Promise<Buffer> {
    this.encryptCalls.push({ ref });
    return Buffer.concat([Buffer.from('KMS:'), this.mask(ref.keyArn, plaintext)]);
  }

  async decrypt(ref: KmsKeyRef, ciphertext: Buffer): Promise<Buffer> {
    this.decryptCalls.push({ ref });
    if (ciphertext.subarray(0, 4).toString() !== 'KMS:') {
      throw new Error('KMS InvalidCiphertext');
    }
    return this.mask(ref.keyArn, ciphertext.subarray(4));
  }
}

class FakeRepo {
  rows: OrgKmsConfig[] = [];
  private idc = 0;
  async findOne({ where }: any) {
    return (
      this.rows.find((r) =>
        Object.entries(where).every(([k, v]) => (r as any)[k] === v),
      ) ?? null
    );
  }
  create(partial: Partial<OrgKmsConfig>) {
    return {
      id: `k_${++this.idc}`,
      enabled: false,
      cmkArn: null,
      awsRegion: null,
      wrappedDek: null,
      retiredDeks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...partial,
    } as OrgKmsConfig;
  }
  async save(r: OrgKmsConfig) {
    const i = this.rows.findIndex((x) => x.id === r.id);
    if (i >= 0) this.rows[i] = r;
    else this.rows.push(r);
    return r;
  }
}

class FakeLicense {
  entitled = new Set<string>([EE_ENTITLEMENTS.BYO_KMS]);
  async hasForOrg(_orgId: string, entitlement: string): Promise<boolean> {
    return this.entitled.has(entitlement);
  }
}

const ORG = 'org-rotating';

describe('BYO-KMS key rotation', () => {
  let kms: FakeKms;
  let repo: FakeRepo;
  let license: FakeLicense;
  let envelope: EnvelopeCryptoService;
  let provisioning: KmsProvisioningService;

  /** A replica that has never seen this org: no cache, only the stored row. */
  const coldReplica = () =>
    new EnvelopeCryptoService(
      repo as any,
      license as any,
      kms as unknown as KmsClientFactory,
    );

  beforeEach(() => {
    kms = new FakeKms();
    repo = new FakeRepo();
    license = new FakeLicense();
    envelope = coldReplica();
    provisioning = new KmsProvisioningService(
      repo as any,
      kms as unknown as KmsClientFactory,
      envelope,
    );
  });

  afterEach(() => {
    registerEnvelopeUnwrapHook(null);
  });

  // ── the scenario that used to lose data ──────────────────────────────────

  it('reads a secret sealed before the rotation that replaced its key', async () => {
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const sealed = await envelope.encryptForOrg(ORG, 'sk-sealed-under-the-first-key');
    expect(sealed.startsWith('encrypted:kms:')).toBe(true);

    const rotated = await provisioning.rotateCmk(ORG, { cmkArn: CMK_B });

    // The org really did move to a different key under a different CMK.
    expect(rotated.cmkArn).toBe(CMK_B);
    expect(rotated.activeKeyId).not.toBe(rotated.retiredKeyIds[0]);

    // The secret sealed before the rotation still reads back.
    expect(await envelope.decryptForOrg(ORG, sealed)).toBe(
      'sk-sealed-under-the-first-key',
    );
  });

  it('a replica that never saw the old key still reads a pre-rotation secret', async () => {
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const sealed = await envelope.encryptForOrg(ORG, 'sk-before');
    await provisioning.rotateCmk(ORG, { cmkArn: CMK_B });

    // Nothing cached, nothing invalidated — only the row to go on.
    expect(await coldReplica().decryptForOrg(ORG, sealed)).toBe('sk-before');
  });

  it('unwraps a retired DEK with the CMK that wrapped it, not the current one', async () => {
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const sealed = await envelope.encryptForOrg(ORG, 'sk-wrapped-by-a');
    await provisioning.rotateCmk(ORG, { cmkArn: CMK_B });

    const replica = coldReplica();
    expect(await replica.decryptForOrg(ORG, sealed)).toBe('sk-wrapped-by-a');

    // The unwrap that produced the retired DEK went to CMK A. Had it gone to
    // the org's current CMK, the DEK would have come back wrong and the read
    // above would have failed its GCM tag.
    expect(kms.decryptCalls.map((c) => c.ref.keyArn)).toContain(CMK_A);
  });

  // ── the key id is what makes it work ─────────────────────────────────────

  it('stamps the sealing key id into the ciphertext', async () => {
    const attached = await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const sealed = await envelope.encryptForOrg(ORG, 'sk-one');

    const [, , keyId] = sealed.split(':');
    expect(keyId).toBe(attached.activeKeyId);
    expect(keyId).toBe(keyIdOf(repo.rows[0].wrappedDek as string));
    // encrypted:kms:<keyId>:<iv>:<tag>:<ct>
    expect(sealed.split(':')).toHaveLength(6);
  });

  it('seals new values under the new key and old values keep naming the old one', async () => {
    const attached = await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const before = await envelope.encryptForOrg(ORG, 'sk-before');
    const rotated = await provisioning.rotateCmk(ORG, { cmkArn: CMK_B });
    const after = await envelope.encryptForOrg(ORG, 'sk-after');

    expect(before.split(':')[2]).toBe(attached.activeKeyId);
    expect(after.split(':')[2]).toBe(rotated.activeKeyId);
    expect(rotated.retiredKeyIds).toEqual([attached.activeKeyId]);

    expect(await envelope.decryptForOrg(ORG, before)).toBe('sk-before');
    expect(await envelope.decryptForOrg(ORG, after)).toBe('sk-after');
  });

  it('survives repeated rotations — every era of secret stays readable', async () => {
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const first = await envelope.encryptForOrg(ORG, 'sk-era-one');
    await provisioning.rotateCmk(ORG, { cmkArn: CMK_B });
    const second = await envelope.encryptForOrg(ORG, 'sk-era-two');
    await provisioning.rotateCmk(ORG, { cmkArn: CMK_C });
    const third = await envelope.encryptForOrg(ORG, 'sk-era-three');

    // Three distinct keys named by three distinct sets of values.
    const ids = [first, second, third].map((v) => v.split(':')[2]);
    expect(new Set(ids).size).toBe(3);

    const replica = coldReplica();
    expect(await replica.decryptForOrg(ORG, first)).toBe('sk-era-one');
    expect(await replica.decryptForOrg(ORG, second)).toBe('sk-era-two');
    expect(await replica.decryptForOrg(ORG, third)).toBe('sk-era-three');
  });

  it('refuses a key id it has no wrapped DEK for instead of guessing', async () => {
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const sealed = await envelope.encryptForOrg(ORG, 'sk-real');

    const fields = sealed.slice('encrypted:kms:'.length).split(':');
    const forged = `encrypted:kms:${'0'.repeat(16)}:${fields.slice(1).join(':')}`;

    await expect(envelope.decryptForOrg(ORG, forged)).rejects.toThrow(
      /no wrapped DEK is stored for key id/,
    );
    // And the real value is unaffected.
    expect(await envelope.decryptForOrg(ORG, sealed)).toBe('sk-real');
  });

  it('refuses an envelope value with no key id rather than misreading its fields', async () => {
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const sealed = await envelope.encryptForOrg(ORG, 'sk-real');
    const withoutKeyId = `encrypted:kms:${sealed
      .slice('encrypted:kms:'.length)
      .split(':')
      .slice(1)
      .join(':')}`;

    await expect(envelope.decryptForOrg(ORG, withoutKeyId)).rejects.toThrow(
      /Malformed envelope value/,
    );
  });

  // ── the sync read path (how credentials are actually read) ───────────────

  it('reads a pre-rotation credential through the sync unwrap hook after warm', async () => {
    envelope.onModuleInit();
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });

    const credential = new Credential();
    credential.organizationId = ORG;
    credential.type = CredentialType.BEARER_TOKEN;
    credential.isActive = true;
    credential.config = { token: 'tok-sealed-before-rotation' } as any;
    await credential.encryptSensitiveDataForOrg(envelope);
    expect((credential.config as any).token.startsWith('encrypted:kms:')).toBe(true);

    await provisioning.rotateCmk(ORG, { cmkArn: CMK_B });

    // A fresh replica warms the org and reads synchronously, the way the
    // provider/credential helpers do.
    const replica = coldReplica();
    replica.onModuleInit();
    await replica.warmOrg(ORG);
    expect(credential.getDecryptedConfig().token).toBe('tok-sealed-before-rotation');
    expect(credential.getAuthHeaders()).toEqual({
      Authorization: 'Bearer tok-sealed-before-rotation',
    });
  });

  it('warms every key the org can unwrap, not just the active one', async () => {
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const before = await envelope.encryptForOrg(ORG, 'sk-before');
    await provisioning.rotateCmk(ORG, { cmkArn: CMK_B });
    const after = await envelope.encryptForOrg(ORG, 'sk-after');

    const replica = coldReplica();
    await replica.warmOrg(ORG);

    // Both reads are served from the warmed cache — synchronously, so neither
    // can have gone to KMS.
    expect(replica.decryptCached(ORG, before)).toBe('sk-before');
    expect(replica.decryptCached(ORG, after)).toBe('sk-after');
  });

  // ── enable / disable does not orphan anything ───────────────────────────

  it('keeps pre-existing secrets readable while the envelope path is disabled', async () => {
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const sealed = await envelope.encryptForOrg(ORG, 'sk-sealed-then-disabled');

    await provisioning.setEnabled(ORG, false);

    // New values go back to the platform path...
    const fresh = await envelope.encryptForOrg(ORG, 'sk-while-disabled');
    expect(fresh.startsWith('encrypted:gcm:')).toBe(true);

    // ...and the already-sealed one is still readable, on a cold replica and
    // through the sync path.
    const replica = coldReplica();
    expect(await replica.decryptForOrg(ORG, sealed)).toBe('sk-sealed-then-disabled');
    await replica.warmOrg(ORG);
    expect(replica.decryptCached(ORG, sealed)).toBe('sk-sealed-then-disabled');
  });

  it('re-enabling resumes the same active key and orphans nothing', async () => {
    const attached = await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const sealed = await envelope.encryptForOrg(ORG, 'sk-across-the-toggle');

    await provisioning.setEnabled(ORG, false);
    const reenabled = await provisioning.setEnabled(ORG, true);

    expect(reenabled.activeKeyId).toBe(attached.activeKeyId);
    expect(reenabled.retiredKeyIds).toEqual([]);

    const again = await envelope.encryptForOrg(ORG, 'sk-after-the-toggle');
    expect(again.split(':')[2]).toBe(attached.activeKeyId);
    expect(await envelope.decryptForOrg(ORG, sealed)).toBe('sk-across-the-toggle');
  });

  it('rotating while disabled still retains the outgoing key', async () => {
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    const sealed = await envelope.encryptForOrg(ORG, 'sk-sealed-before-disable');
    await provisioning.setEnabled(ORG, false);

    const rotated = await provisioning.rotateCmk(ORG, { cmkArn: CMK_B });
    expect(rotated.retiredKeyIds).toHaveLength(1);

    expect(await coldReplica().decryptForOrg(ORG, sealed)).toBe(
      'sk-sealed-before-disable',
    );
  });

  // ── the platform path is untouched by any of this ────────────────────────

  it('leaves platform-prefixed values on the platform path across a rotation', async () => {
    license.entitled.clear();
    const platform = await envelope.encryptForOrg(ORG, 'sk-platform');
    expect(platform.startsWith('encrypted:gcm:')).toBe(true);

    license.entitled.add(EE_ENTITLEMENTS.BYO_KMS);
    await provisioning.attachCmk(ORG, { cmkArn: CMK_A });
    await provisioning.rotateCmk(ORG, { cmkArn: CMK_B });

    const decryptsBefore = kms.decryptCalls.length;
    expect(await envelope.decryptForOrg(ORG, platform)).toBe('sk-platform');
    // Prefix routing sent it to the platform path — no KMS involved.
    expect(kms.decryptCalls.length).toBe(decryptsBefore);
  });
});
