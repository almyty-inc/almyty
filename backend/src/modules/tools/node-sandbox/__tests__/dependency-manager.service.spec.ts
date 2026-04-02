import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { DependencyManagerService } from '../dependency-manager.service';

/**
 * Integration tests for DependencyManagerService.
 *
 * These tests perform REAL filesystem I/O and REAL npm installs in a temp
 * directory. They are intentionally slow (~10-30s each) but prove the service
 * works end-to-end.
 */

let service: DependencyManagerService;
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-deps-test-'));
  process.env.SANDBOX_DEPS_PATH = tmpDir;
  service = new DependencyManagerService();
});

afterAll(() => {
  // Clean up temp directory
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  delete process.env.SANDBOX_DEPS_PATH;
});

describe('DependencyManagerService', () => {
  it('should install a real tiny package (is-odd@3.0.1)', async () => {
    const result = await service.ensureInstalled({ 'is-odd': '3.0.1' });

    expect(result.cached).toBe(false);
    expect(result.installTimeMs).toBeGreaterThan(0);
    expect(result.installDir).toBeTruthy();
    expect(fs.existsSync(path.join(result.installDir, 'node_modules', 'is-odd'))).toBe(true);
    expect(fs.existsSync(path.join(result.installDir, '.installed'))).toBe(true);
  }, 60_000);

  it('should return a cache hit on second call with same deps', async () => {
    const result = await service.ensureInstalled({ 'is-odd': '3.0.1' });

    expect(result.cached).toBe(true);
    expect(result.installTimeMs).toBe(0);
  }, 10_000);

  it('should use different directories for different dependencies', async () => {
    const result1 = await service.ensureInstalled({ 'is-odd': '3.0.1' });
    const result2 = await service.ensureInstalled({ 'is-even': '1.0.0' });

    expect(result1.installDir).not.toBe(result2.installDir);
  }, 60_000);

  it('should produce deterministic hash regardless of key order', async () => {
    // Both should resolve to the same directory (cache hit on the second)
    const result1 = await service.ensureInstalled({ 'is-odd': '3.0.1', 'is-even': '1.0.0' });
    const result2 = await service.ensureInstalled({ 'is-even': '1.0.0', 'is-odd': '3.0.1' });

    expect(result1.installDir).toBe(result2.installDir);
    expect(result2.cached).toBe(true);
  }, 60_000);

  it('should write lock file with correct metadata', async () => {
    const deps = { 'is-odd': '3.0.1' };
    const result = await service.ensureInstalled(deps);

    const lockPath = path.join(result.installDir, '.installed');
    expect(fs.existsSync(lockPath)).toBe(true);

    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(lockData.dependencies).toEqual(deps);
    expect(lockData.installedAt).toBeTruthy();
    expect(lockData.hash).toBeTruthy();
    expect(new Date(lockData.installedAt).getTime()).not.toBeNaN();
  }, 10_000);

  it('should NOT create lock file on failed install', async () => {
    // Use a non-existent package name to force failure
    await expect(
      service.ensureInstalled({ 'this-package-absolutely-does-not-exist-xyz-999': '0.0.0' }),
    ).rejects.toThrow();

    // The directory should have been cleaned up entirely
    const entries = fs.readdirSync(tmpDir);
    // None of the remaining entries should have .installed for the bad package
    for (const entry of entries) {
      const lockPath = path.join(tmpDir, entry, '.installed');
      if (fs.existsSync(lockPath)) {
        const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        expect(data.dependencies).not.toHaveProperty(
          'this-package-absolutely-does-not-exist-xyz-999',
        );
      }
    }
  }, 60_000);

  it('should write .npmrc for private registries', async () => {
    const deps = { 'is-odd': '3.0.1' };
    const registry = {
      url: 'https://npm.example.com',
      authToken: 'secret-token-123',
      scope: '@myorg',
    };

    // Use a unique dep set so we don't hit cache
    const uniqueDeps = { ...deps, 'is-number': '7.0.0' };
    const result = await service.ensureInstalled(uniqueDeps, registry);

    const npmrcPath = path.join(result.installDir, '.npmrc');
    expect(fs.existsSync(npmrcPath)).toBe(true);

    const npmrcContent = fs.readFileSync(npmrcPath, 'utf-8');
    expect(npmrcContent).toContain('@myorg:registry=https://npm.example.com');
    expect(npmrcContent).toContain('//npm.example.com/:_authToken=secret-token-123');
  }, 60_000);

  it('should list cached entries', async () => {
    const cached = service.listCached();
    expect(cached.length).toBeGreaterThan(0);
    expect(cached[0]).toHaveProperty('hash');
    expect(cached[0]).toHaveProperty('installedAt');
    expect(cached[0]).toHaveProperty('deps');
  });

  it('should clear cache', async () => {
    // Re-install something so we have data
    await service.ensureInstalled({ 'is-odd': '3.0.1' });
    expect(service.listCached().length).toBeGreaterThan(0);

    service.clearCache();

    // After clear, base path doesn't exist or is empty
    if (fs.existsSync(tmpDir)) {
      expect(fs.readdirSync(tmpDir).length).toBe(0);
    }
    expect(service.listCached()).toEqual([]);
  }, 10_000);
});
