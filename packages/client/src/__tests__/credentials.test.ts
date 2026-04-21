/**
 * Tests for credential resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Mock fs before importing the module
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { loadCredentials, resolveCredentials, CREDENTIALS_FILE } from '../credentials.js';
import { readFileSync, existsSync } from 'node:fs';

describe('credentials', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv.ALMYTY_TOKEN = process.env.ALMYTY_TOKEN;
    savedEnv.ALMYTY_URL = process.env.ALMYTY_URL;
    delete process.env.ALMYTY_TOKEN;
    delete process.env.ALMYTY_URL;
  });

  afterEach(() => {
    if (savedEnv.ALMYTY_TOKEN !== undefined) {
      process.env.ALMYTY_TOKEN = savedEnv.ALMYTY_TOKEN;
    } else {
      delete process.env.ALMYTY_TOKEN;
    }
    if (savedEnv.ALMYTY_URL !== undefined) {
      process.env.ALMYTY_URL = savedEnv.ALMYTY_URL;
    } else {
      delete process.env.ALMYTY_URL;
    }
  });

  describe('CREDENTIALS_FILE', () => {
    it('should point to ~/.almyty/credentials.json', () => {
      expect(CREDENTIALS_FILE).toBe(join(homedir(), '.almyty', 'credentials.json'));
    });
  });

  describe('loadCredentials', () => {
    it('should return null when file does not exist', () => {
      (existsSync as any).mockReturnValue(false);
      expect(loadCredentials()).toBeNull();
    });

    it('should parse valid credentials file', () => {
      const creds = { url: 'https://api.almyty.com', token: 'tok-123', email: 'test@test.com' };
      (existsSync as any).mockReturnValue(true);
      (readFileSync as any).mockReturnValue(JSON.stringify(creds));

      const result = loadCredentials();
      expect(result?.url).toBe('https://api.almyty.com');
      expect(result?.token).toBe('tok-123');
      expect(result?.email).toBe('test@test.com');
    });

    it('should return null on malformed JSON', () => {
      (existsSync as any).mockReturnValue(true);
      (readFileSync as any).mockReturnValue('not json');

      expect(loadCredentials()).toBeNull();
    });

    it('should return null on read error', () => {
      (existsSync as any).mockReturnValue(true);
      (readFileSync as any).mockImplementation(() => { throw new Error('EACCES'); });

      expect(loadCredentials()).toBeNull();
    });
  });

  describe('resolveCredentials', () => {
    it('should prefer ALMYTY_TOKEN env var', () => {
      process.env.ALMYTY_TOKEN = 'env-token';
      process.env.ALMYTY_URL = 'https://custom.api.com';

      const result = resolveCredentials();
      expect(result?.token).toBe('env-token');
      expect(result?.url).toBe('https://custom.api.com');
    });

    it('should default URL to api.almyty.com when only token is set', () => {
      process.env.ALMYTY_TOKEN = 'env-token';

      const result = resolveCredentials();
      expect(result?.url).toBe('https://api.almyty.com');
    });

    it('should fall back to stored credentials', () => {
      const creds = { url: 'https://api.staging.almyty.com', token: 'stored-token' };
      (existsSync as any).mockReturnValue(true);
      (readFileSync as any).mockReturnValue(JSON.stringify(creds));

      const result = resolveCredentials();
      expect(result?.token).toBe('stored-token');
      expect(result?.url).toBe('https://api.staging.almyty.com');
    });

    it('should return null when nothing is configured', () => {
      (existsSync as any).mockReturnValue(false);
      expect(resolveCredentials()).toBeNull();
    });

    it('should return null when stored credentials have no token', () => {
      const creds = { url: 'https://api.almyty.com' };
      (existsSync as any).mockReturnValue(true);
      (readFileSync as any).mockReturnValue(JSON.stringify(creds));

      expect(resolveCredentials()).toBeNull();
    });
  });
});
