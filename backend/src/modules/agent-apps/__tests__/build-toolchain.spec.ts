import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  BUN_TARGETS,
  ELECTRON_BUILDER_VERSION,
  ELECTRON_TARGETS,
  electronVersionOf,
  electronBuilderArgs,
  electronBuilderCommand,
  localElectronBuilderPath,
  safeExecutableName,
  MAX_LOG_CHARS,
  ProcessToolchainRunner,
  TOOL_FOR_TARGET,
  toolchainReadiness,
  type ToolchainRunner,
} from '../build-toolchain';

describe('ProcessToolchainRunner', () => {
  const runner = new ProcessToolchainRunner();

  it('runs a real command and captures its output', async () => {
    const result = await runner.run('echo', ['hello from the build']);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello from the build');
    expect(result.error).toBeNull();
  });

  it('reports a non-zero exit as a failure with the code', async () => {
    const result = await runner.run('sh', ['-c', 'exit 3']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited with code 3/);
  });

  it('says plainly when the tool is not installed', async () => {
    // The common real failure: a deployment without bun. It should read
    // as a missing dependency, not as a mysterious spawn error.
    const result = await runner.run('definitely-not-a-real-tool-xyz', []);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not installed on the build host/);
  });

  it('passes arguments as an array, so a crafted app name cannot inject a command', async () => {
    // If this were interpolated into a shell string, the semicolon
    // would run a second command and the output would contain "pwned".
    const result = await runner.run('echo', ['; echo pwned']);
    expect(result.output).toContain('; echo pwned');
    expect(result.output).not.toMatch(/^pwned$/m);
  });

  it('does not hand the child the parent environment wholesale', async () => {
    // A build container's environment holds unrelated secrets.
    process.env.ALMYTY_TOOLCHAIN_LEAK_CHECK = 'super-secret';
    const result = await runner.run('sh', ['-c', 'echo "${ALMYTY_TOOLCHAIN_LEAK_CHECK:-absent}"']);
    delete process.env.ALMYTY_TOOLCHAIN_LEAK_CHECK;
    expect(result.output).toContain('absent');
  });

  it('passes through only what it was explicitly given', async () => {
    const result = await runner.run('sh', ['-c', 'echo "$BUILD_VERSION"'], {
      env: { BUILD_VERSION: '1.2.3' },
    });
    expect(result.output).toContain('1.2.3');
  });

  it('caps captured output so one noisy build cannot fill the column', async () => {
    const result = await runner.run('sh', ['-c', `yes x | head -c ${MAX_LOG_CHARS * 2}`]);
    // The cap is checked before appending, so the final chunk may
    // overshoot; what matters is that it stops rather than growing
    // without bound.
    expect(result.output.length).toBeLessThan(MAX_LOG_CHARS * 2);
  });

  it('detects a tool that exists and one that does not', async () => {
    await expect(runner.available('echo')).resolves.toBe(true);
    await expect(runner.available('definitely-not-a-real-tool-xyz')).resolves.toBe(false);
  });
});

describe('toolchainReadiness', () => {
  const present: ToolchainRunner = {
    available: async () => true,
    run: async () => ({ ok: true, output: '', error: null }),
  };
  const absent: ToolchainRunner = {
    available: async () => false,
    run: async () => ({ ok: false, output: '', error: 'missing' }),
  };

  it('is ready when the tool is installed', async () => {
    await expect(toolchainReadiness('tui', present)).resolves.toEqual({
      ready: true,
      missing: [],
      reason: null,
    });
  });

  it('names the missing tool rather than failing vaguely', async () => {
    const result = await toolchainReadiness('tui', absent);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['bun']);
    expect(result.reason).toMatch(/bun is not installed/);
  });

  it('refuses targets that do not produce a file', async () => {
    // A web app is served and Slack is someone else's client; neither
    // has anything to compile.
    for (const target of ['web', 'slack']) {
      const result = await toolchainReadiness(target, present);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/does not produce a downloadable file/);
    }
  });
});

describe('platform mapping', () => {
  it('maps every platform to a bun target triple', () => {
    for (const id of ['linux-x64', 'linux-arm64', 'windows-x64', 'macos-arm64', 'macos-x64']) {
      expect(BUN_TARGETS[id]).toMatch(/^bun-/);
    }
  });

  it('cross-compiles to darwin, which is the whole reason no Mac is needed', () => {
    expect(BUN_TARGETS['macos-arm64']).toBe('bun-darwin-arm64');
  });

  it('builds executables with bun and the desktop shell with npx', () => {
    expect(TOOL_FOR_TARGET.tui).toBe('bun');
    expect(TOOL_FOR_TARGET.binary).toBe('bun');
    expect(TOOL_FOR_TARGET.desktop).toBe('npx');
  });
});

describe('ProcessToolchainRunner stdin', () => {
  const runner = new ProcessToolchainRunner();

  it('gives a tool no stdin to prompt on', async () => {
    // A pipe nobody writes to reads to OpenSSL as an available console,
    // so osslsigncode ignored the password it was handed and asked for
    // one, which fails looking exactly like a bad certificate.
    const result = await runner.run('sh', ['-c', 'test -t 0 && echo tty || echo no-tty']);
    expect(result.output.trim()).toBe('no-tty');
  });

  it('does not hang on a tool that tries to read stdin', async () => {
    // Reading gets EOF at once rather than waiting for input that will
    // never come, which would otherwise burn the whole build timeout.
    const result = await runner.run('sh', ['-c', 'cat; echo done']);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('done');
  });
});

describe('targetLabel in readiness reasons', () => {
  const noBun: ToolchainRunner = {
    available: jest.fn().mockResolvedValue(false),
    run: jest.fn(),
  };

  it('names the medium, not the raw enum value', async () => {
    // "cannot build tui" reads like a bug; "the Terminal app" reads
    // like a sentence.
    const r = await toolchainReadiness('tui', noBun);
    expect(r.reason).toContain('Terminal app');
    expect(r.reason).not.toMatch(/build tui\b/);
  });

  it('says a web distribution produces no file in words', async () => {
    const r = await toolchainReadiness('web', noBun);
    expect(r.reason).toContain('Web app');
    expect(r.reason).not.toMatch(/^web /);
  });
});

describe('electronBuilderArgs', () => {
  const base = {
    projectDir: '/w/shell',
    outputDir: '/w/out',
    productName: 'Acme Assistant',
    appId: 'com.acme.assistant',
    version: '2.3.0',
    executableName: 'acme-assistant',
    electronVersion: '39.0.0',
  };

  it('maps a platform id to electron-builder flags', () => {
    const args = electronBuilderArgs({ ...base, platformId: 'windows-x64' })!;
    expect(args).toContain('--win');
    expect(args).toContain('--x64');
  });

  it('refuses a platform electron-builder has no target for', () => {
    expect(electronBuilderArgs({ ...base, platformId: 'solaris-sparc' })).toBeNull();
  });

  it('never publishes, whatever the config says', () => {
    // A build produces a file. Pushing it anywhere is not its job.
    const args = electronBuilderArgs({ ...base, platformId: 'linux-x64' })!;
    expect(args[args.indexOf('--publish') + 1]).toBe('never');
  });

  it('does not let the packager sign with the build host keychain', () => {
    // Signing uses the customer's certificate, applied afterwards.
    // Whatever identity a shared build host happens to hold is not it.
    const args = electronBuilderArgs({ ...base, platformId: 'macos-arm64' })!;
    expect(args).toContain('--config.mac.identity=null');
  });

  it('carries the customer name and bundle id, not ours', () => {
    const args = electronBuilderArgs({ ...base, platformId: 'linux-x64' })!;
    expect(args).toContain('--config.productName=Acme Assistant');
    expect(args).toContain('--config.appId=com.acme.assistant');
  });

  it('passes a name with spaces as one argument', () => {
    // These reach a process boundary from a form field.
    const args = electronBuilderArgs({ ...base, platformId: 'linux-x64' })!;
    expect(args.filter((a) => a.includes('Acme Assistant'))).toHaveLength(1);
  });

  it('names the Electron release explicitly', () => {
    // A build directory is a copy of the shell with no install step, so
    // electron-builder has no node_modules to resolve a range against
    // and fails outright rather than choosing one.
    const args = electronBuilderArgs({ ...base, platformId: 'linux-x64' })!;
    expect(args).toContain('--config.electronVersion=39.0.0');
  });

  it('stamps the build version, not the shell version', () => {
    // Otherwise every artifact carries the shell's package.json version
    // and an update looks identical to what it replaces.
    const args = electronBuilderArgs({ ...base, platformId: 'linux-x64' })!;
    expect(args).toContain('--config.extraMetadata.version=2.3.0');
    expect(args).toContain('--config.buildVersion=2.3.0');
  });

  it('names the format, so the platform default cannot add targets', () => {
    // `--linux` alone builds every default target, which includes a
    // snap, and a failure there fails the whole build.
    const args = electronBuilderArgs({ ...base, platformId: 'linux-x64' })!;
    expect(args[args.indexOf('--linux') + 1]).toBe('AppImage');

    const win = electronBuilderArgs({ ...base, platformId: 'windows-x64' })!;
    expect(win[win.indexOf('--win') + 1]).toBe('nsis');

    const mac = electronBuilderArgs({ ...base, platformId: 'macos-arm64' })!;
    expect(mac[mac.indexOf('--mac') + 1]).toBe('zip');
  });

  it('names the executable after the product, not the npm package', () => {
    // The shell is published as "@almyty/desktop-shell", and Linux
    // refuses an executable called "@almytydesktop-shell".
    const args = electronBuilderArgs({ ...base, platformId: 'linux-x64' })!;
    expect(args).toContain('--config.executableName=acme-assistant');
  });

  it('covers every platform the picker offers', () => {
    for (const id of Object.keys(BUN_TARGETS)) {
      expect(ELECTRON_TARGETS[id]).toBeDefined();
    }
  });
});

describe('electronBuilderCommand', () => {
  const args = ['--linux', 'AppImage', '--x64'];

  it('runs the binary the shell lockfile installed when it is there', async () => {
    const seen: string[] = [];
    const command = await electronBuilderCommand('/opt/shell', args, async (path) => {
      seen.push(path);
      return true;
    });
    expect(seen).toEqual([join('/opt/shell', 'node_modules', '.bin', 'electron-builder')]);
    expect(command).toEqual({ tool: localElectronBuilderPath('/opt/shell'), args });
  });

  it('falls back to npx for exactly the pinned release, never a bare package name', async () => {
    const command = await electronBuilderCommand('/opt/shell', args, async () => false);
    expect(command.tool).toBe('npx');
    expect(command.args).toEqual(['--yes', `electron-builder@${ELECTRON_BUILDER_VERSION}`, ...args]);
    expect(command.args).not.toContain('electron-builder');
  });

  it('checks the real filesystem by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'almyty-shell-'));
    expect((await electronBuilderCommand(dir, args)).tool).toBe('npx');
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(localElectronBuilderPath(dir), '#!/bin/sh\n');
    expect((await electronBuilderCommand(dir, args)).tool).toBe(localElectronBuilderPath(dir));
  });

  it('pins the same exact version the desktop shell locks', () => {
    const shell = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'desktop-shell');
    const pkg = JSON.parse(readFileSync(join(shell, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(shell, 'package-lock.json'), 'utf8'));
    expect(ELECTRON_BUILDER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies['electron-builder']).toBe(ELECTRON_BUILDER_VERSION);
    expect(lock.packages['node_modules/electron-builder'].version).toBe(ELECTRON_BUILDER_VERSION);
  });

  it('is what the build processor runs electron-builder through', () => {
    const source = readFileSync(join(__dirname, '..', 'app-build.processor.ts'), 'utf8');
    expect(source).toContain('electronBuilderCommand(');
    expect(source).not.toMatch(/toolchain\.run\(\s*'npx'/);
  });

  it('leaves the invocation out of the electron-builder arguments', () => {
    const built = electronBuilderArgs({
      platformId: 'linux-x64',
      projectDir: '/w/shell',
      outputDir: '/w/out',
      productName: 'Acme',
      appId: 'com.acme',
      version: '1.0.0',
      executableName: 'acme',
      electronVersion: '39.0.0',
    })!;
    expect(built[0]).toBe('--linux');
    expect(built).not.toContain('--yes');
  });
});

describe('safeExecutableName', () => {
  it('leaves a normal slug alone', () => {
    expect(safeExecutableName('acme-support')).toBe('acme-support');
  });

  it('replaces characters a package manager refuses', () => {
    // Linux allows only letters, digits, hyphens, underscores, dots and
    // spaces, and a slug can be shaped by a customer.
    expect(safeExecutableName('@acme/support')).toBe('acme-support');
    expect(safeExecutableName('acme support!')).toBe('acme-support');
  });

  it('does not leave a leading or trailing separator', () => {
    expect(safeExecutableName('///acme///')).toBe('acme');
  });

  it('falls back rather than returning an empty name', () => {
    expect(safeExecutableName('///')).toBe('app');
    expect(safeExecutableName('')).toBe('app');
  });
});

describe('the Electron release a desktop build packages', () => {
  const shellPackage = JSON.parse(
    readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'packages', 'desktop-shell', 'package.json'), 'utf8'),
  );

  it('is the release the desktop shell pins', () => {
    const electronVersion = electronVersionOf(shellPackage);
    expect(electronVersion).toBe(shellPackage.devDependencies.electron);
    const args = electronBuilderArgs({
      projectDir: '/w/shell',
      outputDir: '/w/out',
      productName: 'Acme',
      appId: 'com.acme',
      version: '1.0.0',
      executableName: 'acme',
      platformId: 'linux-x64',
      electronVersion: electronVersion!,
    })!;
    expect(args).toContain(`--config.electronVersion=${shellPackage.devDependencies.electron}`);
  });

  it('is not written down anywhere in the backend', () => {
    // A second copy is how this drifted: a constant said 33.2.0 while the
    // shell pinned 39.8.10.
    const toolchain = readFileSync(join(__dirname, '..', 'build-toolchain.ts'), 'utf8');
    const processor = readFileSync(join(__dirname, '..', 'app-build.processor.ts'), 'utf8');
    for (const source of [toolchain, processor]) {
      expect(source).not.toMatch(/electronVersion\s*[:=]\s*['"`]\d/);
      expect(source).not.toMatch(/ELECTRON_VERSION\s*=/);
    }
  });

  it.each([
    [{ devDependencies: { electron: '^39.8.10' } }],
    [{ devDependencies: { electron: 'latest' } }],
    [{ devDependencies: {} }],
    [null],
  ])('refuses a shell with no exact pin: %j', (pkg) => {
    expect(electronVersionOf(pkg)).toBeNull();
  });
});
