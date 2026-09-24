import * as dns from 'dns';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

/**
 * `npm install` for a tool's dependencies runs in the BACKEND process,
 * against whatever `npmRegistry.url` the tool (or its API) names. The only
 * check on that URL was "parses, and is http(s)", so a tool author could
 * point the backend at the cloud metadata service, at loopback admin
 * ports, or at anything else on the cluster network -- and, with an
 * `authToken`, have the backend send a bearer header there as well.
 *
 * `spawn` is mocked: nothing here reaches a registry. What is asserted is
 * whether the install is attempted at all.
 */
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: jest.fn(() => {
      const child: any = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      process.nextTick(() => child.emit('close', 0));
      return child;
    }),
  };
});

// eslint-disable-next-line import/first
import { spawn } from 'child_process';
// eslint-disable-next-line import/first
import { DependencyManagerService } from '../dependency-manager.service';

const spawnMock = spawn as unknown as jest.Mock;

/** What the fake DNS answers for each hostname used below. */
const DNS: Record<string, Array<{ address: string; family: number }>> = {
  'registry.npmjs.org': [{ address: '104.16.0.35', family: 4 }],
  'npm.example.com': [{ address: '93.184.215.14', family: 4 }],
  'registry.rebind.example': [{ address: '169.254.169.254', family: 4 }],
  'registry.mixed.example': [
    { address: '93.184.215.14', family: 4 },
    { address: '10.0.0.7', family: 4 },
  ],
  'registry.v6.example': [{ address: 'fd00::1', family: 6 }],
};

describe('npm registry URL is held to the SSRF floor', () => {
  let tmpDir: string;
  let service: DependencyManagerService;
  let lookupSpy: jest.SpyInstance;
  let counter = 0;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-registry-ssrf-'));
    process.env.SANDBOX_DEPS_PATH = tmpDir;
    service = new DependencyManagerService();
    lookupSpy = jest
      .spyOn(dns.promises, 'lookup')
      .mockImplementation((async (host: string) => {
        const answer = DNS[host];
        if (!answer) {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        }
        return answer;
      }) as any);
  });

  afterAll(() => {
    lookupSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SANDBOX_DEPS_PATH;
    delete process.env.NPM_REGISTRY_ALLOW_PRIVATE_URLS;
  });

  beforeEach(() => {
    spawnMock.mockClear();
    delete process.env.NPM_REGISTRY_ALLOW_PRIVATE_URLS;
  });

  // A fresh dependency set per call, so no test is answered from the cache.
  const deps = () => ({ 'is-odd': `3.0.${++counter}` });

  it.each([
    ['cloud metadata IP', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:4873/'],
    ['loopback by name', 'http://localhost:4873/'],
    ['RFC1918', 'http://10.0.0.5/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv4-mapped IPv6 metadata IP', 'http://[::ffff:169.254.169.254]/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]:6379/'],
    ['decimal loopback', 'http://2130706433/'],
    ['metadata hostname', 'http://metadata.google.internal/'],
    ['a public name that resolves to the metadata IP', 'https://registry.rebind.example/'],
    ['a name with one private address among public ones', 'https://registry.mixed.example/'],
    ['a name that resolves to IPv6 ULA', 'https://registry.v6.example/'],
    ['a non-http scheme', 'file:///etc/passwd'],
  ])('refuses %s and never runs npm', async (_label, url) => {
    await expect(service.ensureInstalled(deps(), { url })).rejects.toThrow(/registry/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a scoped registry with an auth token pointed at an internal host', async () => {
    await expect(
      service.ensureInstalled(deps(), {
        url: 'http://10.1.2.3:8080/',
        scope: '@acme',
        authToken: 'tok',
      }),
    ).rejects.toThrow(/registry/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('still installs from a public registry', async () => {
    const result = await service.ensureInstalled(deps(), { url: 'https://registry.npmjs.org/' });
    expect(result.cached).toBe(false);
    expect(spawnMock).toHaveBeenCalled();
  });

  it('still installs from a scoped private registry on a public host', async () => {
    const result = await service.ensureInstalled(deps(), {
      url: 'https://npm.example.com',
      scope: '@myorg',
      authToken: 'secret-token-123',
    });
    const npmrc = fs.readFileSync(path.join(result.installDir, '.npmrc'), 'utf-8');
    expect(npmrc).toContain('@myorg:registry=https://npm.example.com');
  });

  it('lets a self-hosted install opt in to a private registry, scheme rules still apply', async () => {
    process.env.NPM_REGISTRY_ALLOW_PRIVATE_URLS = 'true';
    await expect(
      service.ensureInstalled(deps(), { url: 'http://10.0.0.5:4873/' }),
    ).resolves.toBeDefined();
    await expect(
      service.ensureInstalled(deps(), { url: 'file:///etc/passwd' }),
    ).rejects.toThrow(/registry/i);
  });
});
