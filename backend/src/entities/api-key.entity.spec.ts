import { ApiKey } from './api-key.entity';

describe('ApiKey Entity', () => {
  let apiKey: ApiKey;

  beforeEach(() => {
    apiKey = new ApiKey();
    apiKey.id = 'key-1';
    apiKey.name = 'Test API Key';
    apiKey.keyHash = 'hashed-key-value';
    apiKey.keyPrefix = 'apifai_12';
    apiKey.userId = 'user-1';
    apiKey.organizationId = 'org-1';
    apiKey.isActive = true;
    apiKey.scopes = ['read:apis', 'write:tools'];
    apiKey.rateLimits = { requestsPerMinute: 100, requestsPerHour: 1000 };
    apiKey.metadata = { description: 'Test key' };
    apiKey.expiresAt = new Date(Date.now() + 86400000); // 24 hours from now
    apiKey.lastUsedAt = null;
    apiKey.createdAt = new Date();
  });

  describe('isExpired', () => {
    it('should return false for non-expired key', () => {
      expect(apiKey.isExpired()).toBe(false);
    });

    it('should return true for expired key', () => {
      apiKey.expiresAt = new Date(Date.now() - 1000); // 1 second ago
      expect(apiKey.isExpired()).toBe(true);
    });

    it('should return false for key without expiration', () => {
      apiKey.expiresAt = null;
      expect(apiKey.isExpired()).toBe(false);
    });
  });

  describe('hasScope', () => {
    it('should return true for existing scope', () => {
      expect(apiKey.hasScope('read:apis')).toBe(true);
      expect(apiKey.hasScope('write:tools')).toBe(true);
    });

    it('should return false for non-existing scope', () => {
      expect(apiKey.hasScope('delete:all')).toBe(false);
    });

    it('should return false when no scopes defined', () => {
      apiKey.scopes = [];
      expect(apiKey.hasScope('read:apis')).toBe(false);
    });

    it('should return false when scopes is null', () => {
      apiKey.scopes = null;
      expect(apiKey.hasScope('read:apis')).toBe(false);
    });
  });

  describe('canMakeRequest', () => {
    it('should return true for active, non-expired key', () => {
      expect(apiKey.canMakeRequest()).toBe(true);
    });

    it('should return false for inactive key', () => {
      apiKey.isActive = false;
      expect(apiKey.canMakeRequest()).toBe(false);
    });

    it('should return false for expired key', () => {
      apiKey.expiresAt = new Date(Date.now() - 1000);
      expect(apiKey.canMakeRequest()).toBe(false);
    });
  });

  describe('updateLastUsed', () => {
    it('should update last used timestamp', () => {
      const beforeTime = new Date();
      apiKey.updateLastUsed();
      const afterTime = new Date();

      expect(apiKey.lastUsedAt).toBeInstanceOf(Date);
      expect(apiKey.lastUsedAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(apiKey.lastUsedAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });
  });

  describe('generateKeyHash', () => {
    it('should generate key hash and prefix', () => {
      const apiKeyNew = new ApiKey();
      apiKeyNew.name = 'New Key';

      apiKeyNew.generateKeyHash();

      expect(apiKeyNew.keyHash).toBeDefined();
      expect(apiKeyNew.keyPrefix).toBeDefined();
      expect(apiKeyNew.keyPrefix).toMatch(/^[a-z]+_[a-f0-9]+$/);
    });

    it('should not overwrite existing hash', () => {
      const existingHash = 'existing-hash';
      apiKey.keyHash = existingHash;

      apiKey.generateKeyHash();

      expect(apiKey.keyHash).toBe(existingHash);
    });
  });
});