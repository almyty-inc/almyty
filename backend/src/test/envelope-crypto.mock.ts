import {
  encryptField,
  decryptField,
} from '../common/security/field-crypto';
import { EnvelopeCryptoService } from '../modules/kms/envelope-crypto.service';

/**
 * Minimal EnvelopeCryptoService stand-in for unit specs that don't exercise
 * BYO-KMS. It reproduces the platform-fallback behavior of the real service
 * (no CMK configured): `encryptForOrg` produces the same `encrypted:gcm:`
 * value as the platform field-crypto, `decryptForOrg` routes by prefix, and
 * `warmOrg` is a no-op. Specs that need the customer-managed path should use
 * the real `EnvelopeCryptoService` with a fake KMS client factory instead.
 */
export function makeEnvelopeCryptoMock(): EnvelopeCryptoService {
  return {
    async encryptForOrg(_orgId: string, plaintext: string): Promise<string> {
      return encryptField(plaintext);
    },
    async decryptForOrg(_orgId: string, value: string): Promise<string> {
      return decryptField(value);
    },
    async warmOrg(): Promise<void> {
      /* no-op: no CMK in unit specs */
    },
    decryptCached(_orgId: string, value: string): string {
      return decryptField(value);
    },
    invalidate(): void {
      /* no-op */
    },
  } as unknown as EnvelopeCryptoService;
}
