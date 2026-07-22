import { KmsProvisioningService } from '../kms-provisioning.service';
import { EnvelopeCryptoService } from '../envelope-crypto.service';
import { KmsClientFactory, KmsKeyRef } from '../kms.service';
import { OrgKmsConfig } from '../../../entities/org-kms-config.entity';

const CMK_ARN =
  'arn:aws:kms:eu-west-1:210987654321:key/1111aaaa-2222-3333-4444-555566667777';

class FakeKmsClientFactory {
  failEncrypt = false;
  encryptCalls: Array<{ ref: KmsKeyRef; plaintext: Buffer }> = [];
  async encrypt(ref: KmsKeyRef, plaintext: Buffer): Promise<Buffer> {
    this.encryptCalls.push({ ref, plaintext });
    if (this.failEncrypt) {
      throw new Error('KMS NotFoundException: key does not exist');
    }
    return Buffer.concat([Buffer.from('KMS:'), plaintext]);
  }
  async decrypt(): Promise<Buffer> {
    throw new Error('not used in these tests');
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

describe('KmsProvisioningService', () => {
  let kms: FakeKmsClientFactory;
  let repo: FakeRepo;
  let envelope: { invalidate: jest.Mock };
  let service: KmsProvisioningService;

  beforeEach(() => {
    kms = new FakeKmsClientFactory();
    repo = new FakeRepo();
    envelope = { invalidate: jest.fn() };
    service = new KmsProvisioningService(
      repo as any,
      kms as unknown as KmsClientFactory,
      envelope as unknown as EnvelopeCryptoService,
    );
  });

  it('generates a fresh 32-byte DEK, wraps it via KMS, and stores only the wrapped blob', async () => {
    const view = await service.setCmk('org1', { cmkArn: CMK_ARN });

    expect(kms.encryptCalls.length).toBe(1);
    expect(kms.encryptCalls[0].plaintext.length).toBe(32); // 256-bit DEK
    expect(kms.encryptCalls[0].ref.keyArn).toBe(CMK_ARN);

    const stored = repo.rows[0];
    expect(stored.wrappedDek).toBeTruthy();
    // The stored blob is the WRAPPED form, never the raw DEK.
    const wrapped = Buffer.from(stored.wrappedDek as string, 'base64');
    expect(wrapped.subarray(0, 4).toString()).toBe('KMS:');
    expect(wrapped.subarray(4)).toEqual(kms.encryptCalls[0].plaintext);

    expect(view.provisioned).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view.cmkArn).toBe(CMK_ARN);
    // The view never carries key material.
    expect((view as any).wrappedDek).toBeUndefined();
    expect(envelope.invalidate).toHaveBeenCalledWith('org1');
  });

  it('propagates a KMS Encrypt failure and writes nothing', async () => {
    kms.failEncrypt = true;
    await expect(
      service.setCmk('org2', { cmkArn: CMK_ARN }),
    ).rejects.toThrow(/NotFound|key does not exist/);
    expect(repo.rows.length).toBe(0);
  });

  it('re-wraps (rotates) with a new DEK on a subsequent setCmk', async () => {
    await service.setCmk('org3', { cmkArn: CMK_ARN });
    const firstDek = kms.encryptCalls[0].plaintext.toString('hex');
    await service.setCmk('org3', { cmkArn: CMK_ARN });
    const secondDek = kms.encryptCalls[1].plaintext.toString('hex');
    expect(secondDek).not.toBe(firstDek);
    expect(repo.rows.length).toBe(1); // same row, updated in place
  });

  it('setEnabled toggles the flag and invalidates the cached DEK', async () => {
    await service.setCmk('org4', { cmkArn: CMK_ARN, enabled: true });
    const view = await service.setEnabled('org4', false);
    expect(view.enabled).toBe(false);
    expect(view.provisioned).toBe(true); // wrapped DEK retained
    expect(envelope.invalidate).toHaveBeenCalledWith('org4');
  });

  it('getConfig returns an unprovisioned view for an org with no config', async () => {
    const view = await service.getConfig('nobody');
    expect(view.provisioned).toBe(false);
    expect(view.enabled).toBe(false);
    expect(view.cmkArn).toBeNull();
  });
});
