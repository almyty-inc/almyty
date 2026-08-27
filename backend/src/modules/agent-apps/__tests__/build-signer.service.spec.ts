import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { CredentialType } from '../../../entities/credential.entity';
import { BuildSignerService } from '../build-signer.service';
import { CERTIFICATE_FILENAME } from '../build-signing';

/**
 * Signing an artifact as the customer.
 *
 * The private key reaches a filesystem, so these check what is written,
 * that it is removed, and that a build never claims a signature the
 * tool did not produce.
 */

const ORG = 'org-1';
const APP = 'app-1';

function makeCredential(config: Record<string, any>) {
  return {
    id: 'cred-1',
    organizationId: ORG,
    type: CredentialType.CODE_SIGNING,
    isActive: true,
    getDecryptedConfig: () => config,
  };
}

const APPLE_CONFIG = {
  certificate: Buffer.from('p12').toString('base64'),
  certificatePassword: 'hunter2',
  appleApiKeyId: 'KEY1',
  appleApiIssuer: 'ISS1',
  appleApiKey: 'pem',
};

function makeService(opts: {
  credential?: any;
  distribution?: any;
} = {}) {
  const credentials = { findOne: jest.fn().mockResolvedValue(opts.credential ?? null) };
  const distributions = {
    findOne: jest.fn().mockResolvedValue(
      opts.distribution === undefined
        ? { appId: APP, organizationId: ORG, configuration: { signingCredentialId: 'cred-1' } }
        : opts.distribution,
    ),
  };
  return {
    service: new BuildSignerService(credentials as any, distributions as any),
    credentials,
    distributions,
  };
}

function makeRunner(results: Array<{ ok: boolean; output?: string }>) {
  const run = jest.fn();
  for (const r of results) {
    run.mockResolvedValueOnce({ ok: r.ok, output: r.output ?? '', error: r.ok ? null : 'exit 1' });
  }
  return { available: jest.fn().mockResolvedValue(true), run };
}

describe('BuildSignerService', () => {
  let workDir: string;
  let artifactPath: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), 'signer-test-'));
    artifactPath = join(workDir, 'app');
    await fs.writeFile(artifactPath, 'unsigned bytes');
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  const params = (runner: any) => ({
    appId: APP,
    target: 'tui',
    platform: 'macos-arm64',
    artifactPath,
    workDir,
    runner,
  });

  it('signs nothing for a platform that needs no signature', async () => {
    const { service, distributions } = makeService();
    const runner = makeRunner([]);

    const outcome = await service.sign({ ...params(runner), platform: 'linux-x64' });

    expect(outcome).toEqual({ signed: false, notarised: false, error: null, log: '' });
    // No lookup at all: Linux has no signing story to explain.
    expect(distributions.findOne).not.toHaveBeenCalled();
  });

  it('stays unsigned when no certificate is selected, and says so', async () => {
    const { service } = makeService({ distribution: null });

    const outcome = await service.sign(params(makeRunner([])));

    expect(outcome.signed).toBe(false);
    expect(outcome.error).toMatch(/no signing certificate is selected/i);
  });

  it('stamps the customer identifier on an unsigned macOS artifact', async () => {
    // An unsigned Electron app reports itself to macOS as "Electron",
    // so two customers' products are one application as far as the OS
    // is concerned. Ad-hoc signing does not make it trusted; it makes
    // it theirs.
    const { service } = makeService({
      distribution: {
        appId: APP,
        organizationId: ORG,
        configuration: { bundleId: 'com.acme.probe' },
      },
    });
    const runner = makeRunner([{ ok: true }]);

    const outcome = await service.sign(params(runner));

    expect(outcome.signed).toBe(false);
    expect(runner.run.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--binary-identifier', 'com.acme.probe']),
    );
  });

  it('says unsigned is a choice, not a failure', async () => {
    const { service } = makeService({ distribution: null });
    const outcome = await service.sign(params(makeRunner([])));
    expect(outcome.error).toMatch(/ships unsigned/i);
  });

  it('does not stamp when no bundle identifier was set', async () => {
    const { service } = makeService({
      distribution: { appId: APP, organizationId: ORG, configuration: {} },
    });
    const runner = makeRunner([{ ok: true }]);

    await service.sign(params(runner));

    expect(runner.run).not.toHaveBeenCalled();
  });

  it('does not stamp a platform macOS rules do not apply to', async () => {
    const { service } = makeService({
      distribution: {
        appId: APP,
        organizationId: ORG,
        configuration: { bundleId: 'com.acme.probe' },
      },
    });
    const runner = makeRunner([{ ok: true }]);

    await service.sign({ ...params(runner), platform: 'windows-x64' });

    expect(runner.run).not.toHaveBeenCalled();
  });

  it('ships anyway when the stamping tool is absent', async () => {
    // A failure here changes nothing about the artifact that was
    // already going to ship.
    const { service } = makeService({
      distribution: {
        appId: APP,
        organizationId: ORG,
        configuration: { bundleId: 'com.acme.probe' },
      },
    });
    const runner = { available: jest.fn().mockResolvedValue(false), run: jest.fn() };

    const outcome = await service.sign(params(runner));

    expect(outcome.signed).toBe(false);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('never guesses a certificate the distribution did not name', async () => {
    const { service, credentials } = makeService({
      distribution: { appId: APP, organizationId: ORG, configuration: {} },
    });

    const outcome = await service.sign(params(makeRunner([])));

    expect(credentials.findOne).not.toHaveBeenCalled();
    expect(outcome.signed).toBe(false);
  });

  it('reads the distribution once, not once per thing it needs from it', async () => {
    const { service, distributions } = makeService({ credential: makeCredential(APPLE_CONFIG) });

    await service.sign(params(makeRunner([{ ok: true }, { ok: true }])));

    expect(distributions.findOne).toHaveBeenCalledTimes(1);
  });

  it('signs a macOS binary under the distribution identifier', async () => {
    const { service } = makeService({
      credential: makeCredential(APPLE_CONFIG),
      distribution: {
        appId: APP,
        organizationId: ORG,
        configuration: { signingCredentialId: 'cred-1', bundleId: 'com.acme.probe' },
      },
    });
    const runner = makeRunner([{ ok: true }, { ok: true }]);

    await service.sign(params(runner));

    const args = runner.run.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(['--binary-identifier', 'com.acme.probe']));
  });

  it('looks up the certificate scoped to the distribution owner', async () => {
    // An id copied from another tenant must resolve to nothing.
    const { service, credentials } = makeService({ credential: makeCredential(APPLE_CONFIG) });
    await service.sign(params(makeRunner([{ ok: true }, { ok: true }])));

    expect(credentials.findOne).toHaveBeenCalledWith({
      where: {
        id: 'cred-1',
        organizationId: ORG,
        type: CredentialType.CODE_SIGNING,
        isActive: true,
      },
    });
  });

  it('signs and notarises when both steps succeed', async () => {
    const { service } = makeService({ credential: makeCredential(APPLE_CONFIG) });
    const runner = makeRunner([{ ok: true }, { ok: true }]);

    const outcome = await service.sign(params(runner));

    expect(outcome.signed).toBe(true);
    expect(outcome.notarised).toBe(true);
    expect(outcome.error).toBeNull();
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('reports signed but not notarised when Apple rejects the submission', async () => {
    // The signature is real. Claiming notarisation it does not have is
    // how an app opens on the build machine and nowhere else.
    const { service } = makeService({ credential: makeCredential(APPLE_CONFIG) });

    const outcome = await service.sign(params(makeRunner([{ ok: true }, { ok: false }])));

    expect(outcome.signed).toBe(true);
    expect(outcome.notarised).toBe(false);
    expect(outcome.error).toMatch(/notaris/i);
  });

  it('reports unsigned when the signing step itself fails', async () => {
    const { service } = makeService({ credential: makeCredential(APPLE_CONFIG) });

    const outcome = await service.sign(
      params(makeRunner([{ ok: false, output: 'Mac verify failure' }])),
    );

    expect(outcome.signed).toBe(false);
    expect(outcome.error).toMatch(/password/i);
  });

  it('removes the certificate and password from disk afterwards', async () => {
    const { service } = makeService({ credential: makeCredential(APPLE_CONFIG) });

    await service.sign(params(makeRunner([{ ok: true }, { ok: true }])));

    await expect(fs.stat(join(workDir, CERTIFICATE_FILENAME))).rejects.toThrow();
    await expect(fs.stat(join(workDir, 'certificate-password'))).rejects.toThrow();
    await expect(fs.stat(join(workDir, 'notarisation-key.json'))).rejects.toThrow();
  });

  it('removes the certificate even when signing throws', async () => {
    const { service } = makeService({ credential: makeCredential(APPLE_CONFIG) });
    const runner = {
      available: jest.fn().mockResolvedValue(true),
      run: jest.fn().mockRejectedValue(new Error('host died')),
    };

    await expect(service.sign(params(runner))).rejects.toThrow('host died');

    await expect(fs.stat(join(workDir, CERTIFICATE_FILENAME))).rejects.toThrow();
  });

  it('writes the certificate readable only by the build', async () => {
    const { service } = makeService({ credential: makeCredential(APPLE_CONFIG) });
    let mode: number | undefined;
    const runner = {
      available: jest.fn().mockResolvedValue(true),
      run: jest.fn().mockImplementation(async () => {
        const stat = await fs.stat(join(workDir, CERTIFICATE_FILENAME));
        mode = stat.mode & 0o777;
        return { ok: true, output: '', error: null };
      }),
    };

    await service.sign(params(runner));

    expect(mode).toBe(0o600);
  });

  it('refuses to sign when the deployment lacks the tool', async () => {
    const { service } = makeService({ credential: makeCredential(APPLE_CONFIG) });
    const runner = { available: jest.fn().mockResolvedValue(false), run: jest.fn() };

    const outcome = await service.sign(params(runner));

    expect(outcome.signed).toBe(false);
    expect(outcome.error).toContain('rcodesign');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('does not write the certificate at all when the credential is incomplete', async () => {
    const { service } = makeService({
      credential: makeCredential({ certificate: APPLE_CONFIG.certificate }),
    });

    const outcome = await service.sign(params(makeRunner([])));

    expect(outcome.error).toMatch(/missing/i);
    await expect(fs.stat(join(workDir, CERTIFICATE_FILENAME))).rejects.toThrow();
  });

  it('replaces the Windows binary with the signed copy', async () => {
    const { service } = makeService({
      credential: makeCredential({
        certificate: APPLE_CONFIG.certificate,
        certificatePassword: 'pw',
      }),
    });
    const runner = {
      available: jest.fn().mockResolvedValue(true),
      run: jest.fn().mockImplementation(async () => {
        await fs.writeFile(`${artifactPath}.signed`, 'signed bytes');
        return { ok: true, output: '', error: null };
      }),
    };

    const outcome = await service.sign({ ...params(runner), platform: 'windows-x64' });

    expect(outcome.signed).toBe(true);
    expect(outcome.notarised).toBe(true);
    expect(await fs.readFile(artifactPath, 'utf8')).toBe('signed bytes');
  });

  it('leaves the unsigned binary in place when Windows signing fails', async () => {
    const { service } = makeService({
      credential: makeCredential({
        certificate: APPLE_CONFIG.certificate,
        certificatePassword: 'pw',
      }),
    });

    const outcome = await service.sign({
      ...params(makeRunner([{ ok: false, output: 'nope' }])),
      platform: 'windows-x64',
    });

    expect(outcome.signed).toBe(false);
    expect(await fs.readFile(artifactPath, 'utf8')).toBe('unsigned bytes');
  });

  it('keeps the tool output for the log, so a failure can be diagnosed', async () => {
    // The sentence the operator sees is deliberately vague about paths.
    // Without the raw output somewhere, nobody can tell why it failed.
    const { service } = makeService({ credential: makeCredential(APPLE_CONFIG) });

    const outcome = await service.sign(
      params(makeRunner([{ ok: false, output: 'rcodesign: unable to parse certificate' }])),
    );

    expect(outcome.log).toContain('unable to parse certificate');
    expect(outcome.error).not.toContain('unable to parse certificate');
  });

  describe('kindFor', () => {
    it('reads the signing kind off the platform table', () => {
      const { service } = makeService();
      expect(service.kindFor('macos-arm64')).toBe('apple');
      expect(service.kindFor('windows-x64')).toBe('authenticode');
      expect(service.kindFor('linux-x64')).toBe('none');
    });

    it('treats an unknown platform as needing no signature', () => {
      const { service } = makeService();
      expect(service.kindFor('solaris-sparc')).toBe('none');
    });
  });
});
