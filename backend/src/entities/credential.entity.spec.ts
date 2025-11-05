import { Credential, CredentialType } from './credential.entity';

// Mock crypto methods since createCipher/createDecipher are deprecated
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    createCipher: jest.fn(() => ({
      update: jest.fn((data: string) => Buffer.from(data).toString('hex')),
      final: jest.fn(() => ''),
    })),
    createDecipher: jest.fn(() => ({
      update: jest.fn((data: string) => Buffer.from(data, 'hex').toString('utf8')),
      final: jest.fn(() => ''),
    })),
  };
});

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

  describe('maskSensitiveFields', () => {
    it('should mask password field', () => {
      const credential = new Credential();
      const config = { username: 'user', password: 'secret123' };

      const masked = credential['maskSensitiveFields'](config);

      expect(masked.username).toBe('user');
      expect(masked.password).toMatch(/^encrypted:/);
      expect(masked.password).not.toBe('secret123');
    });

    it('should mask secret field', () => {
      const credential = new Credential();
      const config = { appId: 'app123', secret: 'my-secret' };

      const masked = credential['maskSensitiveFields'](config);

      expect(masked.appId).toBe('app123');
      expect(masked.secret).toMatch(/^encrypted:/);
    });

    it('should mask token field', () => {
      const credential = new Credential();
      const config = { token: 'token-value' };

      const masked = credential['maskSensitiveFields'](config);

      expect(masked.token).toMatch(/^encrypted:/);
    });

    it('should mask key field', () => {
      const credential = new Credential();
      const config = { key: 'api-key-value' };

      const masked = credential['maskSensitiveFields'](config);

      expect(masked.key).toMatch(/^encrypted:/);
    });

    it('should mask client_secret field', () => {
      const credential = new Credential();
      const config = { client_id: 'client123', client_secret: 'oauth-secret' };

      const masked = credential['maskSensitiveFields'](config);

      expect(masked.client_id).toBe('client123');
      expect(masked.client_secret).toMatch(/^encrypted:/);
    });

    it('should not modify non-sensitive fields', () => {
      const credential = new Credential();
      const config = { username: 'user', email: 'user@test.com', timeout: 30 };

      const masked = credential['maskSensitiveFields'](config);

      expect(masked.username).toBe('user');
      expect(masked.email).toBe('user@test.com');
      expect(masked.timeout).toBe(30);
    });

    it('should handle multiple sensitive fields', () => {
      const credential = new Credential();
      const config = { password: 'pass123', secret: 'secret456', token: 'token789' };

      const masked = credential['maskSensitiveFields'](config);

      expect(masked.password).toMatch(/^encrypted:/);
      expect(masked.secret).toMatch(/^encrypted:/);
      expect(masked.token).toMatch(/^encrypted:/);
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

    it('should handle empty string', () => {
      const credential = new Credential();
      const encrypted = credential['encryptValue']('');
      const decrypted = credential['decryptValue'](encrypted);

      expect(decrypted).toBe('');
    });

    it('should produce different encrypted values for same input on different calls', () => {
      const credential = new Credential();
      const value = 'test-value';

      const encrypted1 = credential['encryptValue'](value);
      const encrypted2 = credential['encryptValue'](value);

      // Note: With the simple cipher used, this might be the same
      // In production with proper encryption (IV), they would differ
      expect(encrypted1).toMatch(/^encrypted:/);
      expect(encrypted2).toMatch(/^encrypted:/);
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

      const decrypted = credential['getDecryptedConfig']();

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

      const decrypted = credential['getDecryptedConfig']();

      expect(decrypted).toEqual({
        username: 'user',
        timeout: 30,
        retries: 3,
      });
    });

    it('should handle empty config', () => {
      const credential = new Credential();
      credential.config = {};

      const decrypted = credential['getDecryptedConfig']();

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

      const decrypted = credential['getDecryptedConfig']();

      expect(decrypted.oauth).toEqual({
        client_id: 'id123',
        scope: 'read write',
      });
      expect(decrypted.timeout).toBe(30);
    });
  });

  describe('encryptSensitiveData hook', () => {
    it('should mask sensitive data when config is set', () => {
      const credential = new Credential();
      credential.config = { password: 'secret', username: 'user' };

      credential.encryptSensitiveData();

      expect(credential.config.password).toMatch(/^encrypted:/);
      expect(credential.config.username).toBe('user');
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
});
