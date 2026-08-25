import {
  BUN_TARGETS,
  ELECTRON_TARGETS,
  ELECTRON_VERSION,
  electronBuilderArgs,
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

describe('electronBuilderArgs', () => {
  const base = {
    projectDir: '/w/shell',
    outputDir: '/w/out',
    productName: 'Acme Assistant',
    appId: 'com.acme.assistant',
    version: '2.3.0',
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
    expect(args).toContain(`--config.electronVersion=${ELECTRON_VERSION}`);
    expect(ELECTRON_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('stamps the build version, not the shell version', () => {
    // Otherwise every artifact carries the shell's package.json version
    // and an update looks identical to what it replaces.
    const args = electronBuilderArgs({ ...base, platformId: 'linux-x64' })!;
    expect(args).toContain('--config.extraMetadata.version=2.3.0');
    expect(args).toContain('--config.buildVersion=2.3.0');
  });

  it('covers every platform the picker offers', () => {
    for (const id of Object.keys(BUN_TARGETS)) {
      expect(ELECTRON_TARGETS[id]).toBeDefined();
    }
  });
});
