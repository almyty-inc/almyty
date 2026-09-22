import { ConflictException, NotFoundException } from '@nestjs/common';

import { KmsProvisioningService } from '../kms-provisioning.service';
import {
  EnvelopeCryptoService,
  keyIdOf,
} from '../envelope-crypto.service';
import { KmsClientFactory, KmsKeyRef } from '../kms.service';
import { OrgKmsConfig } from '../../../entities/org-kms-config.entity';

const CMK_ARN =
  'arn:aws:kms:eu-west-1:210987654321:key/1111aaaa-2222-3333-4444-555566667777';
const OTHER_CMK_ARN =
  'arn:aws:kms:eu-west-1:210987654321:key/8888bbbb-9999-aaaa-bbbb-ccccddddeeee';

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
    const view = await service.attachCmk('org1', { cmkArn: CMK_ARN });

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
    // The key id names the stored blob, and nothing is retired yet.
    expect(view.activeKeyId).toBe(keyIdOf(stored.wrappedDek as string));
    expect(view.retiredKeyIds).toEqual([]);
    // The view never carries key material.
    expect((view as any).wrappedDek).toBeUndefined();
    expect((view as any).retiredDeks).toBeUndefined();
    expect(envelope.invalidate).toHaveBeenCalledWith('org1');
  });

  it('propagates a KMS Encrypt failure and writes nothing', async () => {
    kms.failEncrypt = true;
    await expect(
      service.attachCmk('org2', { cmkArn: CMK_ARN }),
    ).rejects.toThrow(/NotFound|key does not exist/);
    expect(repo.rows.length).toBe(0);
  });

  it('refuses to attach over an existing key — replacing one is a rotation', async () => {
    await service.attachCmk('org3', { cmkArn: CMK_ARN });
    const firstBlob = repo.rows[0].wrappedDek;

    await expect(
      service.attachCmk('org3', { cmkArn: OTHER_CMK_ARN }),
    ).rejects.toThrow(ConflictException);

    // Nothing was minted and nothing was overwritten.
    expect(kms.encryptCalls.length).toBe(1);
    expect(repo.rows[0].wrappedDek).toBe(firstBlob);
    expect(repo.rows[0].cmkArn).toBe(CMK_ARN);
  });

  it('rotateCmk mints a new DEK and retains the outgoing one', async () => {
    await service.attachCmk('org4', { cmkArn: CMK_ARN });
    const firstBlob = repo.rows[0].wrappedDek as string;
    const firstDek = kms.encryptCalls[0].plaintext.toString('hex');

    const view = await service.rotateCmk('org4', { cmkArn: OTHER_CMK_ARN });

    const secondDek = kms.encryptCalls[1].plaintext.toString('hex');
    expect(secondDek).not.toBe(firstDek);
    expect(repo.rows.length).toBe(1); // same row, updated in place

    // The new DEK is active under the new CMK...
    expect(view.cmkArn).toBe(OTHER_CMK_ARN);
    expect(view.activeKeyId).toBe(keyIdOf(repo.rows[0].wrappedDek as string));
    expect(repo.rows[0].wrappedDek).not.toBe(firstBlob);

    // ...and the outgoing one is retained, still wrapped by the CMK that
    // wrapped it, so values sealed under it can still be unwrapped.
    expect(view.retiredKeyIds).toEqual([keyIdOf(firstBlob)]);
    expect(repo.rows[0].retiredDeks).toHaveLength(1);
    expect(repo.rows[0].retiredDeks[0]).toMatchObject({
      keyId: keyIdOf(firstBlob),
      wrappedDek: firstBlob,
      cmkArn: CMK_ARN,
    });
    expect(envelope.invalidate).toHaveBeenCalledWith('org4');
  });

  it('rotateCmk keeps the configured CMK when none is supplied', async () => {
    await service.attachCmk('org5', { cmkArn: CMK_ARN, awsRegion: 'eu-west-1' });
    const view = await service.rotateCmk('org5');
    expect(view.cmkArn).toBe(CMK_ARN);
    expect(view.awsRegion).toBe('eu-west-1');
    expect(view.retiredKeyIds).toHaveLength(1);
  });

  it('rotateCmk accumulates every retired key, oldest first', async () => {
    await service.attachCmk('org6', { cmkArn: CMK_ARN });
    const first = repo.rows[0].wrappedDek as string;
    await service.rotateCmk('org6');
    const second = repo.rows[0].wrappedDek as string;
    const view = await service.rotateCmk('org6');

    expect(view.retiredKeyIds).toEqual([keyIdOf(first), keyIdOf(second)]);
  });

  it('rotateCmk propagates a KMS Encrypt failure and changes nothing', async () => {
    await service.attachCmk('org7', { cmkArn: CMK_ARN });
    const blob = repo.rows[0].wrappedDek;
    kms.failEncrypt = true;

    await expect(service.rotateCmk('org7')).rejects.toThrow(
      /NotFound|key does not exist/,
    );

    expect(repo.rows[0].wrappedDek).toBe(blob);
    expect(repo.rows[0].retiredDeks).toEqual([]);
  });

  it('rotateCmk refuses an org with nothing attached', async () => {
    await expect(service.rotateCmk('nobody')).rejects.toThrow(NotFoundException);
  });

  it('setEnabled toggles the flag and invalidates the cached DEK', async () => {
    await service.attachCmk('org8', { cmkArn: CMK_ARN, enabled: true });
    const view = await service.setEnabled('org8', false);
    expect(view.enabled).toBe(false);
    expect(view.provisioned).toBe(true); // wrapped DEK retained
    // Disabling retires nothing and leaves the active key named as before.
    expect(view.activeKeyId).toBe(keyIdOf(repo.rows[0].wrappedDek as string));
    expect(view.retiredKeyIds).toEqual([]);
    expect(envelope.invalidate).toHaveBeenCalledWith('org8');
  });

  it('getConfig returns an unprovisioned view for an org with no config', async () => {
    const view = await service.getConfig('nobody');
    expect(view.provisioned).toBe(false);
    expect(view.enabled).toBe(false);
    expect(view.cmkArn).toBeNull();
    expect(view.activeKeyId).toBeNull();
    expect(view.retiredKeyIds).toEqual([]);
  });
});
