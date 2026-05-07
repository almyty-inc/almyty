import { describe, it, expect } from 'vitest';

import { loadConfig, DEFAULTS } from '../src/config.js';

/**
 * Config layering tests. Every layer claim in the spec gets a test:
 * defaults < global < project < env < flags, and the explicit
 * --config path treated as flag-precedence.
 */
describe('loadConfig', () => {
  it('returns defaults plus required name when no files / env / flags configure anything', () => {
    const r = loadConfig({
      flags: { name: 'r1' },
      env: {},
      exists: () => false,
      readFile: () => '',
    });
    expect(r.config.defaultIsolation).toBe('container');
    expect(r.config.networkBlocked).toBe(true);
    expect(r.config.installBlocked).toBe(true);
    expect(r.binaryProbeList).toEqual(DEFAULTS.binaryProbeList);
    expect(r.backendUrl).toBe('https://api.almyty.com');
  });

  it('global file overrides defaults', () => {
    const files: Record<string, string> = {
      '/global.json': JSON.stringify({
        name: 'from-global',
        config: { defaultIsolation: 'host', networkBlocked: false },
      }),
    };
    const r = loadConfig({
      env: {},
      exists: p => p in files,
      readFile: p => files[p] ?? '',
      globalPath: '/global.json',
      projectPath: '/no.json',
    });
    expect(r.name).toBe('from-global');
    expect(r.config.defaultIsolation).toBe('host');
    expect(r.config.networkBlocked).toBe(false);
    // installBlocked still defaults true: only specified keys are
    // overridden, the rest fall through.
    expect(r.config.installBlocked).toBe(true);
  });

  it('project file overrides global', () => {
    const files: Record<string, string> = {
      '/global.json': JSON.stringify({ name: 'from-global', config: { defaultIsolation: 'host' } }),
      '/project.json': JSON.stringify({ name: 'from-project' }),
    };
    const r = loadConfig({
      env: {},
      exists: p => p in files,
      readFile: p => files[p] ?? '',
      globalPath: '/global.json',
      projectPath: '/project.json',
    });
    expect(r.name).toBe('from-project');
    // defaultIsolation flowed through global because project didn't
    // override it: precedence applies per-key, not whole-object.
    expect(r.config.defaultIsolation).toBe('host');
  });

  it('env overrides files for the keys it knows about', () => {
    const files: Record<string, string> = {
      '/global.json': JSON.stringify({ name: 'from-global', backendUrl: 'https://from-global' }),
    };
    const r = loadConfig({
      env: { ALMYTY_URL: 'https://from-env', ALMYTY_RUNNER_NAME: 'from-env' },
      exists: p => p in files,
      readFile: p => files[p] ?? '',
      globalPath: '/global.json',
      projectPath: '/no.json',
    });
    expect(r.name).toBe('from-env');
    expect(r.backendUrl).toBe('https://from-env');
  });

  it('CLI flags override everything below', () => {
    const files: Record<string, string> = {
      '/global.json': JSON.stringify({ name: 'from-global' }),
    };
    const r = loadConfig({
      env: { ALMYTY_RUNNER_NAME: 'from-env' },
      exists: p => p in files,
      readFile: p => files[p] ?? '',
      globalPath: '/global.json',
      projectPath: '/no.json',
      flags: { name: 'from-flag', backendUrl: 'https://from-flag' },
    });
    expect(r.name).toBe('from-flag');
    expect(r.backendUrl).toBe('https://from-flag');
  });

  it('--config path overrides both files and env', () => {
    const files: Record<string, string> = {
      '/global.json': JSON.stringify({ name: 'from-global' }),
      '/explicit.json': JSON.stringify({ name: 'from-explicit', config: { maxConcurrent: 16 } }),
    };
    const r = loadConfig({
      env: {},
      exists: p => p in files,
      readFile: p => files[p] ?? '',
      globalPath: '/global.json',
      projectPath: '/no.json',
      flags: { configPath: '/explicit.json' },
    });
    expect(r.name).toBe('from-explicit');
    expect(r.config.maxConcurrent).toBe(16);
  });

  it('throws when --config path does not exist', () => {
    expect(() => loadConfig({
      env: {},
      exists: () => false,
      readFile: () => '',
      flags: { name: 'r', configPath: '/nope.json' },
    })).toThrow(/config file not found/);
  });

  it('throws when invalid ALMYTY_RUNNER_ISOLATION is set', () => {
    expect(() => loadConfig({
      env: { ALMYTY_RUNNER_ISOLATION: 'wasm' },
      exists: () => false,
      readFile: () => '',
      flags: { name: 'r' },
    })).toThrow(/container, host/);
  });

  it('throws when no name is configured anywhere', () => {
    expect(() => loadConfig({
      env: {},
      exists: () => false,
      readFile: () => '',
    })).toThrow(/runner name is required/);
  });

  it('flag labels merge with file labels rather than replace them', () => {
    const files: Record<string, string> = {
      '/global.json': JSON.stringify({
        name: 'r1',
        labels: { env: 'dev', os: 'macos' },
      }),
    };
    const r = loadConfig({
      env: {},
      exists: p => p in files,
      readFile: p => files[p] ?? '',
      globalPath: '/global.json',
      projectPath: '/no.json',
      flags: { labels: { env: 'staging', tier: 'a' } },
    });
    expect(r.labels).toEqual({ env: 'staging', os: 'macos', tier: 'a' });
  });

  it('rejects malformed JSON with a clear error', () => {
    expect(() => loadConfig({
      env: {},
      exists: () => true,
      readFile: () => '{bad json',
      globalPath: '/global.json',
      projectPath: '/no.json',
      flags: { name: 'r' },
    })).toThrow(/failed to parse \/global\.json/);
  });
});
