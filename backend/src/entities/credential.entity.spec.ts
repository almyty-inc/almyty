import { Credential, CredentialType } from './credential.entity';

describe('Credential Entity', () => {
  describe('isExpired', () => {
    it('should return true if expiresAt is in the past', () => {
      const credential = new Credential();
      credential.expiresAt = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago

      expect(credential.isExpired()).toBe(true);
    });

    it('should return false if expiresAt is in the future', () => {
      const credential = new Credential();
      credential.expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour from now

      expect(credential.isExpired()).toBe(false);
    });

    it('should return false if expiresAt is not set', () => {
      const credential = new Credential();
      credential.expiresAt = null;

      expect(credential.isExpired()).toBe(false);
    });
  });

  describe('isValid', () => {
    it('should return true if active and not expired', () => {
      const credential = new Credential();
      credential.isActive = true;
      credential.expiresAt = new Date(Date.now() + 1000 * 60 * 60);

      expect(credential.isValid()).toBe(true);
    });

    it('should return false if not active', () => {
      const credential = new Credential();
      credential.isActive = false;
      credential.expiresAt = new Date(Date.now() + 1000 * 60 * 60);

      expect(credential.isValid()).toBe(false);
    });

    it('should return false if expired', () => {
      const credential = new Credential();
      credential.isActive = true;
      credential.expiresAt = new Date(Date.now() - 1000 * 60 * 60);

      expect(credential.isValid()).toBe(false);
    });

    it('should return true if active and no expiration', () => {
      const credential = new Credential();
      credential.isActive = true;
      credential.expiresAt = null;

      expect(credential.isValid()).toBe(true);
    });
  });

  describe('getAuthHeaders', () => {
    it('should return API key in header for API_KEY type with header location', () => {
      const credential = new Credential();
      credential.type = CredentialType.API_KEY;
      credential.keyLocation = 'header';
      credential.keyName = 'X-Custom-Key';
      credential.isActive = true;
      credential.config = { apiKey: 'test-api-key-123' };

      const headers = credential.getAuthHeaders();

      expect(headers['X-Custom-Key']).toBe('test-api-key-123');
    });

    it('should use default header name if keyName not set for API_KEY', () => {
      const credential = new Credential();
      credential.type = CredentialType.API_KEY;
      credential.keyLocation = 'header';
      credential.isActive = true;
      credential.config = { apiKey: 'test-key' };

      const headers = credential.getAuthHeaders();

      expect(headers['X-API-Key']).toBe('test-key');
    });

    it('should return Bearer token for BEARER_TOKEN type', () => {
      const credential = new Credential();
      credential.type = CredentialType.BEARER_TOKEN;
      credential.isActive = true;
      credential.config = { token: 'bearer-token-xyz' };

      const headers = credential.getAuthHeaders();

      expect(headers.Authorization).toBe('Bearer bearer-token-xyz');
    });

    it('should return Basic auth for BASIC_AUTH type', () => {
      const credential = new Credential();
      credential.type = CredentialType.BASIC_AUTH;
      credential.isActive = true;
      credential.config = { username: 'testuser', password: 'testpass' };

      const headers = credential.getAuthHeaders();

      expect(headers.Authorization).toMatch(/^Basic /);
      const decoded = Buffer.from(headers.Authorization.replace('Basic ', ''), 'base64').toString();
      expect(decoded).toBe('testuser:testpass');
    });

    it('should return Bearer token for JWT type', () => {
      const credential = new Credential();
      credential.type = CredentialType.JWT;
      credential.isActive = true;
      credential.config = { token: 'jwt-token-abc' };

      const headers = credential.getAuthHeaders();

      expect(headers.Authorization).toBe('Bearer jwt-token-abc');
    });

    it('should send raw JWT in custom (non-Authorization) header without Bearer prefix', () => {
      const credential = new Credential();
      credential.type = CredentialType.JWT;
      credential.isActive = true;
      credential.config = { token: 'jwt-token-abc', headerName: 'X-Auth-Token' };

      const headers = credential.getAuthHeaders();

      expect(headers['X-Auth-Token']).toBe('jwt-token-abc');
      expect(headers.Authorization).toBeUndefined();
    });

    it('should still apply Bearer prefix when JWT headerName is explicitly Authorization', () => {
      // Regression: the old branch was on whether headerName was set at
      // ALL, so explicitly setting it to 'Authorization' silently
      // dropped the `Bearer ` prefix and broke real APIs.
      const credential = new Credential();
      credential.type = CredentialType.JWT;
      credential.isActive = true;
      credential.config = { token: 'jwt-token-abc', headerName: 'Authorization' };

      const headers = credential.getAuthHeaders();

      expect(headers.Authorization).toBe('Bearer jwt-token-abc');
    });

    it('should return empty object if credential is not valid', () => {
      const credential = new Credential();
      credential.type = CredentialType.BEARER_TOKEN;
      credential.isActive = false;
      credential.config = { token: 'token' };

      const headers = credential.getAuthHeaders();

      expect(headers).toEqual({});
    });

    it('should return empty object for unknown credential type', () => {
      const credential = new Credential();
      credential.type = CredentialType.CUSTOM;
      credential.isActive = true;
      credential.config = { data: 'test' };

      const headers = credential.getAuthHeaders();

      expect(headers).toEqual({});
    });

    it('should decrypt encrypted config values', () => {
      const credential = new Credential();
      credential.type = CredentialType.BEARER_TOKEN;
      credential.isActive = true;

      // Simulate encrypted value
      const plainToken = 'my-secret-token';
      const encryptedToken = credential['encryptValue'](plainToken);
      credential.config = { token: encryptedToken };

      const headers = credential.getAuthHeaders();

      expect(headers.Authorization).toBe(`Bearer ${plainToken}`);
    });
  });

  describe('getQueryParams', () => {
    it('should return API key as query param for API_KEY with query location', () => {
      const credential = new Credential();
      credential.type = CredentialType.API_KEY;
      credential.keyLocation = 'query';
      credential.keyName = 'apikey';
      credential.isActive = true;
      credential.config = { apiKey: 'query-key-123' };

      const params = credential.getQueryParams();

      expect(params.apikey).toBe('query-key-123');
    });

    it('should use default param name if keyName not set', () => {
      const credential = new Credential();
      credential.type = CredentialType.API_KEY;
      credential.keyLocation = 'query';
      credential.isActive = true;
      credential.config = { apiKey: 'test-key' };

      const params = credential.getQueryParams();

      expect(params.api_key).toBe('test-key');
    });

    it('should return empty object if credential is not valid', () => {
      const credential = new Credential();
      credential.type = CredentialType.API_KEY;
      credential.keyLocation = 'query';
      credential.isActive = false;
      credential.config = { apiKey: 'key' };

      const params = credential.getQueryParams();

      expect(params).toEqual({});
    });

    it('should return empty object if type is not API_KEY', () => {
      const credential = new Credential();
      credential.type = CredentialType.BEARER_TOKEN;
      credential.isActive = true;
      credential.config = { token: 'token' };

      const params = credential.getQueryParams();

      expect(params).toEqual({});
    });

    it('should return empty object if keyLocation is not query', () => {
      const credential = new Credential();
      credential.type = CredentialType.API_KEY;
      credential.keyLocation = 'header';
      credential.isActive = true;
      credential.config = { apiKey: 'key' };

      const params = credential.getQueryParams();

      expect(params).toEqual({});
    });
  });

  describe('updateLastUsed', () => {
    it('should update lastUsedAt to current time', () => {
      const credential = new Credential();
      const beforeTime = Date.now();

      credential.updateLastUsed();

      const afterTime = Date.now();
      expect(credential.lastUsedAt.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(credential.lastUsedAt.getTime()).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('testConnection', () => {
    it('should return true if credential is valid and has config', () => {
      const credential = new Credential();
      credential.isActive = true;
      credential.config = { apiKey: 'test-key', endpoint: 'https://api.example.com' };

      expect(credential.testConnection()).toBe(true);
    });

    it('should return false if credential is not valid', () => {
      const credential = new Credential();
      credential.isActive = false;
      credential.config = { apiKey: 'test-key' };

      expect(credential.testConnection()).toBe(false);
    });

    it('should return false if config is empty', () => {
      const credential = new Credential();
      credential.isActive = true;
      credential.config = {};

      expect(credential.testConnection()).toBe(false);
    });
  });

  describe('encryptSensitiveData', () => {
    it('should encrypt password field', () => {
      const credential = new Credential();
      credential.config = { username: 'user', password: 'secret123' };

      credential.encryptSensitiveData();

      expect(credential.config.username).toBe('user');
      expect(credential.config.password).toMatch(/^encrypted:/);
      expect(credential.config.password).not.toBe('secret123');
    });

    it('should encrypt secret field', () => {
      const credential = new Credential();
      credential.config = { appId: 'app123', secret: 'my-secret' };

      credential.encryptSensitiveData();

      expect(credential.config.appId).toBe('app123');
      expect(credential.config.secret).toMatch(/^encrypted:/);
    });

    it('should encrypt token field', () => {
      const credential = new Credential();
      credential.config = { token: 'token-value' };

      credential.encryptSensitiveData();

      expect(credential.config.token).toMatch(/^encrypted:/);
    });

    it('should encrypt key field', () => {
      const credential = new Credential();
      credential.config = { key: 'api-key-value' };

      credential.encryptSensitiveData();

      expect(credential.config.key).toMatch(/^encrypted:/);
    });

    it('should encrypt client_secret field', () => {
      const credential = new Credential();
      credential.config = { client_id: 'client123', client_secret: 'oauth-secret' };

      credential.encryptSensitiveData();

      expect(credential.config.client_id).toBe('client123');
      expect(credential.config.client_secret).toMatch(/^encrypted:/);
    });

    it('should not modify non-sensitive fields', () => {
      const credential = new Credential();
      credential.config = { username: 'user', email: 'user@test.com', timeout: 30 };

      credential.encryptSensitiveData();

      expect(credential.config.username).toBe('user');
      expect(credential.config.email).toBe('user@test.com');
      expect(credential.config.timeout).toBe(30);
    });

    it('should encrypt multiple sensitive fields', () => {
      const credential = new Credential();
      credential.config = { password: 'pass123', secret: 'secret456', token: 'token789' };

      credential.encryptSensitiveData();

      expect(credential.config.password).toMatch(/^encrypted:/);
      expect(credential.config.secret).toMatch(/^encrypted:/);
      expect(credential.config.token).toMatch(/^encrypted:/);
    });

    it('should not re-encrypt already encrypted values', () => {
      const credential = new Credential();
      credential.config = { token: 'my-token' };

      credential.encryptSensitiveData();
      const firstEncrypted = credential.config.token;

      credential.encryptSensitiveData();
      expect(credential.config.token).toBe(firstEncrypted);
    });

    it('should handle null config', () => {
      const credential = new Credential();
      credential.config = null;

      expect(() => credential.encryptSensitiveData()).not.toThrow();
    });

    it('should handle non-object config', () => {
      const credential = new Credential();
      credential.config = 'not-an-object' as any;

      expect(() => credential.encryptSensitiveData()).not.toThrow();
    });
  });

  describe('encryptValue and decryptValue', () => {
    it('should encrypt and decrypt value correctly', () => {
      const credential = new Credential();
      const originalValue = 'my-secret-value';

      const encrypted = credential['encryptValue'](originalValue);
      expect(encrypted).toMatch(/^encrypted:/);
      expect(encrypted).not.toBe(originalValue);

      const decrypted = credential['decryptValue'](encrypted);
      expect(decrypted).toBe(originalValue);
    });

    it('should return value unchanged if not encrypted', () => {
      const credential = new Credential();
      const plainValue = 'plain-text';

      const result = credential['decryptValue'](plainValue);

      expect(result).toBe(plainValue);
    });

    it('should THROW (not silently return) on a malformed encrypted value', () => {
      // Regression: a payload like `encrypted:foo` (missing IV or
      // ciphertext) used to be returned as the literal string and then
      // sent over the wire as the actual auth value. Fail loudly so the
      // bad value is never used in a request.
      const credential = new Credential();
      expect(() => credential['decryptValue']('encrypted:foo')).toThrow(/Malformed/);
      expect(() => credential['decryptValue']('encrypted:')).toThrow(/Malformed/);
    });

    it('should handle empty string', () => {
      const credential = new Credential();
      const encrypted = credential['encryptValue']('');
      const decrypted = credential['decryptValue'](encrypted);

      expect(decrypted).toBe('');
    });

    it('should produce different encrypted values for same input (random IV)', () => {
      const credential = new Credential();
      const value = 'test-value';

      const encrypted1 = credential['encryptValue'](value);
      const encrypted2 = credential['encryptValue'](value);

      // With proper IV-based encryption, these should differ
      expect(encrypted1).toMatch(/^encrypted:/);
      expect(encrypted2).toMatch(/^encrypted:/);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('encryptValue produces the new GCM format `encrypted:gcm:<iv>:<authTag>:<ct>`', () => {
      const credential = new Credential();
      const out = credential['encryptValue']('hello');

      const parts = out.split(':');
      expect(parts[0]).toBe('encrypted');
      expect(parts[1]).toBe('gcm');
      expect(parts).toHaveLength(5);
      // 96-bit IV → 24 hex chars
      expect(parts[2]).toMatch(/^[0-9a-f]{24}$/);
      // GCM auth tag is 16 bytes → 32 hex chars
      expect(parts[3]).toMatch(/^[0-9a-f]{32}$/);
      // ciphertext is hex
      expect(parts[4]).toMatch(/^[0-9a-f]+$/);
    });

    it('decryptValue still reads the LEGACY CBC format (`encrypted:<iv>:<ct>`)', () => {
      // Build a legacy CBC payload manually so we can prove the
      // backward-read path still works without committing the bytes
      // to a fixture file.
      const cryptoMod = require('crypto');
      const credential = new Credential();
      // Use the same key the entity uses (test/dev fallback).
      const key = cryptoMod
        .createHash('sha256')
        .update(process.env.ENCRYPTION_KEY || 'default-encryption-key-change-me!')
        .digest();
      const iv = cryptoMod.randomBytes(16);
      const cipher = cryptoMod.createCipheriv('aes-256-cbc', key, iv);
      const plain = 'legacy-secret-value';
      let ct = cipher.update(plain, 'utf8', 'hex');
      ct += cipher.final('hex');
      const legacyPayload = `encrypted:${iv.toString('hex')}:${ct}`;

      // The decrypt path must transparently understand the old shape.
      expect(credential['decryptValue'](legacyPayload)).toBe(plain);
    });

    it('decryptValue rejects a tampered GCM payload (authenticated encryption)', () => {
      const credential = new Credential();
      const out = credential['encryptValue']('original');
      // Flip a byte in the ciphertext segment.
      const parts = out.split(':');
      const tampered = parts[4].replace(/[0-9a-f]$/, (c) => (c === '0' ? '1' : '0'));
      const corrupted = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:${tampered}`;

      // CBC would silently produce garbage plaintext (or pad-error). GCM
      // verifies the auth tag and refuses to decrypt.
      expect(() => credential['decryptValue'](corrupted)).toThrow();
    });

    it('encryptSensitiveData migrates legacy CBC fields to GCM on save', () => {
      const cryptoMod = require('crypto');
      const credential = new Credential();
      const key = cryptoMod
        .createHash('sha256')
        .update(process.env.ENCRYPTION_KEY || 'default-encryption-key-change-me!')
        .digest();
      const iv = cryptoMod.randomBytes(16);
      const cipher = cryptoMod.createCipheriv('aes-256-cbc', key, iv);
      let ct = cipher.update('migrate-me', 'utf8', 'hex');
      ct += cipher.final('hex');
      const legacyPayload = `encrypted:${iv.toString('hex')}:${ct}`;

      credential.config = {
        apiKey: legacyPayload,
        username: 'plain-username', // non-sensitive: untouched
        token: 'plain-token',       // sensitive plain → encrypt fresh
      };

      credential.encryptSensitiveData();

      // The legacy CBC field is now GCM.
      expect(credential.config.apiKey.startsWith('encrypted:gcm:')).toBe(true);
      // Round-trip decryption still yields the original plaintext.
      expect(credential['decryptValue'](credential.config.apiKey)).toBe('migrate-me');
      // The freshly-encrypted token is also GCM.
      expect(credential.config.token.startsWith('encrypted:gcm:')).toBe(true);
      // Non-sensitive fields untouched.
      expect(credential.config.username).toBe('plain-username');
    });
  });

  describe('getEncryptionKey (production safety)', () => {
    const ORIGINAL_ENV = process.env.NODE_ENV;
    const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = ORIGINAL_ENV;
      if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
    });

    it('should HARD-FAIL if NODE_ENV=production and ENCRYPTION_KEY is missing', () => {
      // Regression: previously fell back to a hardcoded default key, so
      // anyone with read access to the source could decrypt every stored
      // credential in any production deployment that forgot to set the
      // env var.
      process.env.NODE_ENV = 'production';
      delete process.env.ENCRYPTION_KEY;

      const credential = new Credential();
      expect(() => credential['encryptValue']('secret')).toThrow(/ENCRYPTION_KEY/);
    });

    it('should still allow encryption in dev/test when ENCRYPTION_KEY is missing', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.ENCRYPTION_KEY;

      const credential = new Credential();
      expect(() => credential['encryptValue']('secret')).not.toThrow();
    });

    it('should accept an explicit ENCRYPTION_KEY in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.ENCRYPTION_KEY = 'explicit-test-key-not-the-default';

      const credential = new Credential();
      const encrypted = credential['encryptValue']('secret');
      expect(encrypted).toMatch(/^encrypted:/);
      expect(credential['decryptValue'](encrypted)).toBe('secret');
    });
  });

  describe('getDecryptedConfig', () => {
    it('should decrypt all encrypted values in config', () => {
      const credential = new Credential();
      const plainPassword = 'my-password';
      const plainToken = 'my-token';

      const encryptedPassword = credential['encryptValue'](plainPassword);
      const encryptedToken = credential['encryptValue'](plainToken);

      credential.config = {
        username: 'user',
        password: encryptedPassword,
        token: encryptedToken,
        endpoint: 'https://api.example.com',
      };

      const decrypted = credential.getDecryptedConfig();

      expect(decrypted.username).toBe('user');
      expect(decrypted.password).toBe(plainPassword);
      expect(decrypted.token).toBe(plainToken);
      expect(decrypted.endpoint).toBe('https://api.example.com');
    });

    it('should leave non-encrypted values unchanged', () => {
      const credential = new Credential();
      credential.config = {
        username: 'user',
        timeout: 30,
        retries: 3,
      };

      const decrypted = credential.getDecryptedConfig();

      expect(decrypted).toEqual({
        username: 'user',
        timeout: 30,
        retries: 3,
      });
    });

    it('should handle empty config', () => {
      const credential = new Credential();
      credential.config = {};

      const decrypted = credential.getDecryptedConfig();

      expect(decrypted).toEqual({});
    });

    it('should handle config with nested objects', () => {
      const credential = new Credential();
      credential.config = {
        oauth: {
          client_id: 'id123',
          scope: 'read write',
        },
        timeout: 30,
      };

      const decrypted = credential.getDecryptedConfig();

      expect(decrypted.oauth).toEqual({
        client_id: 'id123',
        scope: 'read write',
      });
      expect(decrypted.timeout).toBe(30);
    });
  });
});
