/**
 * Verifies `KmsClientFactory` against a MOCKED `@aws-sdk/client-kms` — no live
 * AWS credentials, no network. The mock's `Encrypt` returns a deterministic
 * wrapped blob and `Decrypt` reverses it, so a wrap -> unwrap round-trip is
 * exercised through the real command-dispatch code path.
 */

const sends: any[] = [];

jest.mock('@aws-sdk/client-kms', () => {
  class EncryptCommand {
    constructor(public input: any) {}
    readonly _type = 'Encrypt';
  }
  class DecryptCommand {
    constructor(public input: any) {}
    readonly _type = 'Decrypt';
  }
  class KMSClient {
    constructor(public config: any) {}
    async send(cmd: any) {
      sends.push({ type: cmd._type, input: cmd.input, region: this.config?.region });
      if (cmd._type === 'Encrypt') {
        // Deterministic "wrap": prepend a marker to the plaintext DEK.
        const pt: Uint8Array = cmd.input.Plaintext;
        const blob = Buffer.concat([Buffer.from('WRAP:'), Buffer.from(pt)]);
        return { CiphertextBlob: new Uint8Array(blob) };
      }
      if (cmd._type === 'Decrypt') {
        const ct: Uint8Array = cmd.input.CiphertextBlob;
        const buf = Buffer.from(ct);
        if (buf.subarray(0, 5).toString() !== 'WRAP:') {
          throw new Error('InvalidCiphertextException');
        }
        return { Plaintext: new Uint8Array(buf.subarray(5)) };
      }
      throw new Error('unexpected command');
    }
  }
  return { KMSClient, EncryptCommand, DecryptCommand };
});

import { KmsClientFactory } from '../kms.service';

const CMK_ARN =
  'arn:aws:kms:ap-southeast-2:999988887777:key/dead-beef-cafe-babe-0000';

describe('KmsClientFactory (mocked AWS SDK)', () => {
  let factory: KmsClientFactory;

  beforeEach(() => {
    sends.length = 0;
    factory = new KmsClientFactory();
  });

  it('wraps then unwraps a DEK, reversing exactly', async () => {
    const dek = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 bytes
    const wrapped = await factory.encrypt({ keyArn: CMK_ARN }, dek);
    expect(wrapped.subarray(0, 5).toString()).toBe('WRAP:');

    const unwrapped = await factory.decrypt({ keyArn: CMK_ARN }, wrapped);
    expect(unwrapped).toEqual(dek);

    expect(sends.map((s) => s.type)).toEqual(['Encrypt', 'Decrypt']);
    expect(sends[0].input.KeyId).toBe(CMK_ARN);
  });

  it('derives the region from the ARN when none is supplied', async () => {
    await factory.encrypt({ keyArn: CMK_ARN }, Buffer.from('x'));
    expect(sends[0].region).toBe('ap-southeast-2');
  });

  it('prefers an explicit region over the ARN region', async () => {
    await factory.encrypt({ keyArn: CMK_ARN, region: 'us-west-1' }, Buffer.from('x'));
    expect(sends[0].region).toBe('us-west-1');
  });

  it('throws when Decrypt receives a blob it cannot reverse', async () => {
    await expect(
      factory.decrypt({ keyArn: CMK_ARN }, Buffer.from('garbage')),
    ).rejects.toThrow(/InvalidCiphertext/);
  });
});
