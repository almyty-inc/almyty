import { Credential, CredentialType } from '../credential.entity';

/**
 * Tests for Credential entity methods using REAL entity instances (no mocks).
 */

function createCredential(overrides: Partial<Credential> = {}): Credential {
  const cred = new Credential();
  cred.id = 'test-id';
  cred.name = 'Test Credential';
  cred.type = CredentialType.API_KEY;
  cred.config = {};
  cred.isActive = true;
  cred.expiresAt = null;
  cred.keyName = null;
  cred.keyLocation = null;
  Object.assign(cred, overrides);
  return cred;
}

describe('Credential entity methods', () => {
  describe('encryptSensitiveData + getDecryptedConfig round-trip', () => {
    it('should encrypt and then decrypt back to the original values', () => {
      const cred = createCredential({
        config: {
          apiKey: 'sk-live-abc123',
          username: 'admin',
          password: 'supersecret',
          token: 'my-bearer-token',
          clientSecret: 'oauth-secret',
          nonSensitive: 'keep-me-plain',
        },
      });

      cred.encryptSensitiveData();

      // Sensitive fields should be encrypted
      expect(cred.config.apiKey).toMatch(/^encrypted:/);
      expect(cred.config.password).toMatch(/^encrypted:/);
      expect(cred.config.token).toMatch(/^encrypted:/);
      expect(cred.config.clientSecret).toMatch(/^encrypted:/);

      // Non-sensitive fields should remain plain
      expect(cred.config.username).toBe('admin');
      expect(cred.config.nonSensitive).toBe('keep-me-plain');

      // Decrypt and verify round-trip
      const decrypted = cred.getDecryptedConfig();
      expect(decrypted.apiKey).toBe('sk-live-abc123');
      expect(decrypted.password).toBe('supersecret');
      expect(decrypted.token).toBe('my-bearer-token');
      expect(decrypted.clientSecret).toBe('oauth-secret');
      expect(decrypted.username).toBe('admin');
      expect(decrypted.nonSensitive).toBe('keep-me-plain');
    });

    it('should not double-encrypt already encrypted values', () => {
      const cred = createCredential({
        config: { apiKey: 'my-key' },
      });

      cred.encryptSensitiveData();
      const afterFirst = cred.config.apiKey;

      cred.encryptSensitiveData();
      const afterSecond = cred.config.apiKey;

      // The value should still be encrypted but not double-encrypted
      expect(afterSecond).toMatch(/^encrypted:/);
      // Decrypt should still work
      const decrypted = cred.getDecryptedConfig();
      expect(decrypted.apiKey).toBe('my-key');
    });

    it('should handle empty config gracefully', () => {
      const cred = createCredential({ config: {} });
      cred.encryptSensitiveData();
      expect(cred.config).toEqual({});
      expect(cred.getDecryptedConfig()).toEqual({});
    });

    it('should handle config with accessToken and refreshToken', () => {
      const cred = createCredential({
        config: {
          accessToken: 'access-123',
          refreshToken: 'refresh-456',
        },
      });

      cred.encryptSensitiveData();
      expect(cred.config.accessToken).toMatch(/^encrypted:/);
      expect(cred.config.refreshToken).toMatch(/^encrypted:/);

      const decrypted = cred.getDecryptedConfig();
      expect(decrypted.accessToken).toBe('access-123');
      expect(decrypted.refreshToken).toBe('refresh-456');
    });
  });

  describe('getAuthHeaders', () => {
    it('should return API key header when type is API_KEY and location is header', () => {
      const cred = createCredential({
        type: CredentialType.API_KEY,
        keyLocation: 'header',
        keyName: 'X-API-Key',
        config: { apiKey: 'test-key-123' },
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({ 'X-API-Key': 'test-key-123' });
    });

    it('should use default header name for API_KEY when keyName is not set', () => {
      const cred = createCredential({
        type: CredentialType.API_KEY,
        keyLocation: 'header',
        keyName: null,
        config: { apiKey: 'test-key' },
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({ 'X-API-Key': 'test-key' });
    });

    it('should return empty for API_KEY when location is query', () => {
      const cred = createCredential({
        type: CredentialType.API_KEY,
        keyLocation: 'query',
        config: { apiKey: 'test-key' },
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({});
    });

    it('should return Bearer token header for BEARER_TOKEN type', () => {
      const cred = createCredential({
        type: CredentialType.BEARER_TOKEN,
        config: { token: 'my-bearer-token' },
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({ Authorization: 'Bearer my-bearer-token' });
    });

    it('should return Basic auth header for BASIC_AUTH type', () => {
      const cred = createCredential({
        type: CredentialType.BASIC_AUTH,
        config: { username: 'user', password: 'pass' },
      });

      const headers = cred.getAuthHeaders();
      const expected = Buffer.from('user:pass').toString('base64');
      expect(headers).toEqual({ Authorization: `Basic ${expected}` });
    });

    it('should return JWT header with default Authorization header', () => {
      const cred = createCredential({
        type: CredentialType.JWT,
        config: { token: 'jwt-token-value' },
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({ Authorization: 'Bearer jwt-token-value' });
    });

    it('should return JWT header with custom header name', () => {
      const cred = createCredential({
        type: CredentialType.JWT,
        config: { token: 'jwt-token-value', headerName: 'X-JWT-Token' },
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({ 'X-JWT-Token': 'jwt-token-value' });
    });

    it('should return OAuth2 header with Bearer token type by default', () => {
      const cred = createCredential({
        type: CredentialType.OAUTH2,
        config: { accessToken: 'oauth-access-token' },
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({ Authorization: 'Bearer oauth-access-token' });
    });

    it('should return OAuth2 header with custom token type', () => {
      const cred = createCredential({
        type: CredentialType.OAUTH2,
        config: { accessToken: 'oauth-token', tokenType: 'MAC' },
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({ Authorization: 'MAC oauth-token' });
    });

    it('should return empty for OAuth2 without accessToken', () => {
      const cred = createCredential({
        type: CredentialType.OAUTH2,
        config: { refreshToken: 'rt' },
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({});
    });

    it('should return custom header for CUSTOM type', () => {
      const cred = createCredential({
        type: CredentialType.CUSTOM,
        config: { headerName: 'X-Custom', headerValue: 'custom-val' },
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({ 'X-Custom': 'custom-val' });
    });

    it('should return empty for CUSTOM type without headerName or headerValue', () => {
      const cred = createCredential({
        type: CredentialType.CUSTOM,
        config: {},
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({});
    });

    it('should return empty headers when credential is not valid (inactive)', () => {
      const cred = createCredential({
        type: CredentialType.BEARER_TOKEN,
        config: { token: 'my-token' },
        isActive: false,
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({});
    });

    it('should return empty headers when credential is expired', () => {
      const cred = createCredential({
        type: CredentialType.BEARER_TOKEN,
        config: { token: 'my-token' },
        expiresAt: new Date(Date.now() - 60000), // expired 1 minute ago
      });

      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({});
    });

    it('should work with encrypted config values', () => {
      const cred = createCredential({
        type: CredentialType.BEARER_TOKEN,
        config: { token: 'secret-token' },
      });

      // Encrypt first
      cred.encryptSensitiveData();
      expect(cred.config.token).toMatch(/^encrypted:/);

      // getAuthHeaders should still decrypt and return the correct header
      const headers = cred.getAuthHeaders();
      expect(headers).toEqual({ Authorization: 'Bearer secret-token' });
    });
  });

  describe('getQueryParams', () => {
    it('should return query params for API_KEY with query location', () => {
      const cred = createCredential({
        type: CredentialType.API_KEY,
        keyLocation: 'query',
        keyName: 'api_key',
        config: { apiKey: 'query-key-val' },
      });

      const params = cred.getQueryParams();
      expect(params).toEqual({ api_key: 'query-key-val' });
    });

    it('should use default param name when keyName is not set', () => {
      const cred = createCredential({
        type: CredentialType.API_KEY,
        keyLocation: 'query',
        keyName: null,
        config: { apiKey: 'query-key-val' },
      });

      const params = cred.getQueryParams();
      expect(params).toEqual({ api_key: 'query-key-val' });
    });

    it('should return empty for non-API_KEY types', () => {
      const cred = createCredential({
        type: CredentialType.BEARER_TOKEN,
        config: { token: 'tok' },
      });

      const params = cred.getQueryParams();
      expect(params).toEqual({});
    });

    it('should return empty for API_KEY with header location', () => {
      const cred = createCredential({
        type: CredentialType.API_KEY,
        keyLocation: 'header',
        config: { apiKey: 'key-val' },
      });

      const params = cred.getQueryParams();
      expect(params).toEqual({});
    });

    it('should return empty when credential is invalid', () => {
      const cred = createCredential({
        type: CredentialType.API_KEY,
        keyLocation: 'query',
        config: { apiKey: 'key-val' },
        isActive: false,
      });

      const params = cred.getQueryParams();
      expect(params).toEqual({});
    });
  });

  describe('isExpired', () => {
    it('should return false when expiresAt is in the future', () => {
      const cred = createCredential({
        expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
      });

      expect(cred.isExpired()).toBe(false);
    });

    it('should return true when expiresAt is in the past', () => {
      const cred = createCredential({
        expiresAt: new Date(Date.now() - 60000), // 1 minute ago
      });

      expect(cred.isExpired()).toBe(true);
    });

    it('should return false when expiresAt is null', () => {
      const cred = createCredential({
        expiresAt: null,
      });

      expect(cred.isExpired()).toBe(false);
    });
  });

  describe('isValid', () => {
    it('should return true when active and not expired', () => {
      const cred = createCredential({
        isActive: true,
        expiresAt: new Date(Date.now() + 3600000),
      });

      expect(cred.isValid()).toBe(true);
    });

    it('should return true when active and expiresAt is null', () => {
      const cred = createCredential({
        isActive: true,
        expiresAt: null,
      });

      expect(cred.isValid()).toBe(true);
    });

    it('should return false when inactive', () => {
      const cred = createCredential({
        isActive: false,
        expiresAt: null,
      });

      expect(cred.isValid()).toBe(false);
    });

    it('should return false when expired', () => {
      const cred = createCredential({
        isActive: true,
        expiresAt: new Date(Date.now() - 60000),
      });

      expect(cred.isValid()).toBe(false);
    });

    it('should return false when both inactive and expired', () => {
      const cred = createCredential({
        isActive: false,
        expiresAt: new Date(Date.now() - 60000),
      });

      expect(cred.isValid()).toBe(false);
    });
  });
});
