import { encryptField, decryptField, isEncrypted } from './field-crypto';

describe('field-crypto', () => {
  it('round-trips a value through GCM encryption', () => {
    const secret = 'sk-super-secret-key-123';
    const enc = encryptField(secret);
    expect(enc).toMatch(/^encrypted:gcm:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(enc).not.toContain(secret);
    expect(decryptField(enc)).toBe(secret);
  });

  it('uses a fresh IV each time (ciphertext differs, plaintext matches)', () => {
    const a = encryptField('same');
    const b = encryptField('same');
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe('same');
    expect(decryptField(b)).toBe('same');
  });

  it('passes through a non-encrypted (legacy plaintext) value unchanged', () => {
    expect(decryptField('plaintext-key')).toBe('plaintext-key');
    expect(isEncrypted('plaintext-key')).toBe(false);
  });

  it('recognizes encrypted values', () => {
    expect(isEncrypted(encryptField('x'))).toBe(true);
    expect(isEncrypted('encrypted:gcm:aa:bb:cc')).toBe(true);
  });

  it('throws on a tampered GCM ciphertext (authenticated)', () => {
    const enc = encryptField('tamper-me');
    const parts = enc.split(':');
    // Flip a character in the ciphertext segment.
    parts[4] = parts[4].replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    expect(() => decryptField(parts.join(':'))).toThrow();
  });

  it('throws on a malformed encrypted payload rather than returning it raw', () => {
    expect(() => decryptField('encrypted:gcm:onlytwo')).toThrow();
  });
});
