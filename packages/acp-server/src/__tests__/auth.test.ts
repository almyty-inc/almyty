import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveCredentials } from '../auth.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('resolveCredentials', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('reads token from ALMYTY_TOKEN env var', () => {
    process.env.ALMYTY_TOKEN = 'test-token-123';
    const creds = resolveCredentials();
    expect(creds).not.toBeNull();
    expect(creds!.token).toBe('test-token-123');
  });

  it('reads URL from ALMYTY_URL env var', () => {
    process.env.ALMYTY_TOKEN = 'tok';
    process.env.ALMYTY_URL = 'https://custom.api.com';
    const creds = resolveCredentials();
    expect(creds!.url).toBe('https://custom.api.com');
  });

  it('prefers env var over credentials file', () => {
    process.env.ALMYTY_TOKEN = 'env-token';
    const creds = resolveCredentials();
    expect(creds!.token).toBe('env-token');
  });
});
