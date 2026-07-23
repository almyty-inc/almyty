import { Injectable, Logger } from '@nestjs/common';
import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
} from '@aws-sdk/client-kms';

export interface KmsKeyRef {
  /** Fully-qualified CMK ARN. */
  keyArn: string;
  /** Region; when omitted it is derived from the ARN. */
  region?: string | null;
}

/**
 * Thin wrapper around `@aws-sdk/client-kms`. This is the single seam where the
 * envelope-crypto service touches AWS: `wrap` (KMS `Encrypt`) and `unwrap`
 * (KMS `Decrypt`) a Data Encryption Key with a customer's CMK.
 *
 * Isolating the AWS SDK here keeps the crypto service testable without live
 * credentials — specs mock this factory (or the SDK commands it issues) so a
 * wrap→unwrap round-trip can be exercised deterministically. Credentials are
 * resolved by the AWS SDK's default provider chain (env / IRSA / instance
 * profile); almyty never stores the customer's AWS access keys.
 *
 * Clients are cached per region since a `KMSClient` is reusable and each
 * carries its own HTTP connection pool.
 */
@Injectable()
export class KmsClientFactory {
  private readonly logger = new Logger(KmsClientFactory.name);
  private readonly clients = new Map<string, KMSClient>();

  /** Wrap (encrypt) a plaintext DEK with the customer's CMK. Returns ciphertext. */
  async encrypt(ref: KmsKeyRef, plaintext: Buffer): Promise<Buffer> {
    const client = this.clientFor(ref);
    const out = await client.send(
      new EncryptCommand({ KeyId: ref.keyArn, Plaintext: plaintext }),
    );
    if (!out.CiphertextBlob) {
      throw new Error('KMS Encrypt returned no CiphertextBlob');
    }
    return Buffer.from(out.CiphertextBlob);
  }

  /** Unwrap (decrypt) a wrapped DEK with the customer's CMK. Returns plaintext. */
  async decrypt(ref: KmsKeyRef, ciphertext: Buffer): Promise<Buffer> {
    const client = this.clientFor(ref);
    const out = await client.send(
      new DecryptCommand({ KeyId: ref.keyArn, CiphertextBlob: ciphertext }),
    );
    if (!out.Plaintext) {
      throw new Error('KMS Decrypt returned no Plaintext');
    }
    return Buffer.from(out.Plaintext);
  }

  private clientFor(ref: KmsKeyRef): KMSClient {
    const region = ref.region || this.regionFromArn(ref.keyArn);
    // Optional endpoint override for local emulators (e.g. LocalStack KMS).
    // Unset in every real deployment, so the AWS SDK talks to real KMS as
    // before; set only by integration specs / self-hosted emulator setups.
    const endpoint = process.env.AWS_KMS_ENDPOINT || undefined;
    const key = `${region || 'default'}|${endpoint || ''}`;
    let client = this.clients.get(key);
    if (!client) {
      const config: Record<string, unknown> = {};
      if (region) config.region = region;
      if (endpoint) config.endpoint = endpoint;
      client = new KMSClient(config);
      this.clients.set(key, client);
    }
    return client;
  }

  /** arn:aws:kms:<region>:<account>:key/<id> → <region>. */
  private regionFromArn(arn: string): string | undefined {
    const parts = arn.split(':');
    return parts.length >= 4 && parts[3] ? parts[3] : undefined;
  }
}
