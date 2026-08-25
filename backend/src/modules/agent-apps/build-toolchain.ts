import { spawn } from 'child_process';

/**
 * The commands that actually produce an artifact.
 *
 * Isolated behind one interface so the queue, the storage and the API
 * can be exercised without a toolchain present, and so a deployment
 * that lacks `bun` fails with a sentence saying so rather than
 * appearing to succeed and handing someone an empty file.
 *
 * Nothing here shells out to a string built from customer input. Every
 * argument is passed as an array element, because a build takes an app
 * name and a bundle identifier from a form, and those reach a process
 * boundary.
 */

export interface ToolchainResult {
  ok: boolean;
  /** Combined stdout and stderr, kept for the build log. */
  output: string;
  /** A sentence an operator can act on, when it failed. */
  error: string | null;
}

export interface ToolchainRunner {
  /** Whether the tool exists on this host at all. */
  available(tool: string): Promise<boolean>;
  run(tool: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<ToolchainResult>;
}

/** Ceiling on a single toolchain invocation. */
export const TOOLCHAIN_TIMEOUT_MS = 15 * 60 * 1000;

/** Cap on captured output, so one noisy build cannot fill a column. */
export const MAX_LOG_CHARS = 64_000;

export class ProcessToolchainRunner implements ToolchainRunner {
  async available(tool: string): Promise<boolean> {
    const result = await this.run('which', [tool]);
    return result.ok;
  }

  run(
    tool: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<ToolchainResult> {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;

      const finish = (result: ToolchainResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const child = spawn(tool, args, {
        cwd: options.cwd,
        // Inherit nothing by default: a build container's environment
        // holds unrelated secrets, and the toolchain only needs what it
        // is explicitly handed.
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(options.env ?? {}) },
      });

      const capture = (chunk: Buffer) => {
        if (output.length < MAX_LOG_CHARS) output += chunk.toString();
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({
          ok: false,
          output,
          error: `The build ran longer than ${Math.round(TOOLCHAIN_TIMEOUT_MS / 60000)} minutes and was stopped.`,
        });
      }, TOOLCHAIN_TIMEOUT_MS);
      timer.unref?.();

      child.on('error', (err: any) => {
        clearTimeout(timer);
        finish({
          ok: false,
          output,
          error:
            err?.code === 'ENOENT'
              ? `${tool} is not installed on the build host.`
              : `Could not start ${tool}: ${err?.message ?? err}`,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        finish({
          ok: code === 0,
          output,
          error: code === 0 ? null : `${tool} exited with code ${code}.`,
        });
      });
    });
  }
}

/** Which tool produces which target. */
export const TOOL_FOR_TARGET: Record<string, string> = {
  tui: 'bun',
  binary: 'bun',
  // electron-builder is run through npx so a build host does not have
  // to carry a global install, but it still has to be reachable.
  desktop: 'npx',
};

/** bun's target triple for one of our platform ids. */
export const BUN_TARGETS: Record<string, string> = {
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'windows-x64': 'bun-windows-x64',
  'macos-arm64': 'bun-darwin-arm64',
  'macos-x64': 'bun-darwin-x64',
};

/**
 * Whether this host can build a target at all, and what is missing.
 *
 * Checked before queueing rather than inside the job, so an operator
 * finds out immediately instead of watching something sit queued and
 * then fail.
 */
export async function toolchainReadiness(
  target: string,
  runner: ToolchainRunner,
): Promise<{ ready: boolean; missing: string[]; reason: string | null }> {
  const tool = TOOL_FOR_TARGET[target];
  if (!tool) {
    return { ready: false, missing: [], reason: `${target} does not produce a downloadable file.` };
  }

  const present = await runner.available(tool);
  if (!present) {
    return {
      ready: false,
      missing: [tool],
      reason: `This deployment cannot build ${target} because ${tool} is not installed on the build host.`,
    };
  }
  return { ready: true, missing: [], reason: null };
}

/**
 * Modules the bundler must not try to resolve.
 *
 * ink imports react-devtools-core at the top of a devtools module that
 * only runs when DEV is set. Bun resolves imports statically, so it
 * fails the whole build over a dependency the artifact never loads.
 * Marking it external leaves the import in place and unreached.
 */
export const BUNDLE_EXTERNALS: readonly string[] = Object.freeze(['react-devtools-core']);

/** Arguments for compiling the terminal client to a single executable. */
export function bunCompileArgs(
  entry: string,
  bunTarget: string,
  outfile: string,
): string[] {
  const args = ['build', entry, '--compile', `--target=${bunTarget}`, '--outfile', outfile];
  for (const external of BUNDLE_EXTERNALS) args.push('--external', external);
  return args;
}

/**
 * electron-builder's platform and architecture flags for one of our
 * platform ids.
 *
 * Windows and Linux cross-build from anywhere. macOS does not: Apple's
 * bundle format needs tooling that only exists on a Mac, which is why
 * the desktop app on macOS is the one target that wants a Mac host.
 */
export const ELECTRON_TARGETS: Record<string, { platform: string; arch: string; format: string }> = {
  'linux-x64': { platform: '--linux', arch: '--x64', format: 'AppImage' },
  'linux-arm64': { platform: '--linux', arch: '--arm64', format: 'AppImage' },
  'windows-x64': { platform: '--win', arch: '--x64', format: 'nsis' },
  'macos-arm64': { platform: '--mac', arch: '--arm64', format: 'zip' },
  'macos-x64': { platform: '--mac', arch: '--x64', format: 'zip' },
};

/**
 * The Electron release the shell is packaged against.
 *
 * Passed explicitly because electron-builder resolves the runtime from
 * an installed node_modules or a fixed version in package.json, and a
 * build directory has neither: it is a copy of the shell with no
 * install step. A range fails outright rather than picking a release.
 */
export const ELECTRON_VERSION = '33.2.0';

/**
 * Arguments for packaging the desktop shell.
 *
 * `--publish never` because a build must never push anything anywhere;
 * this produces a file and stops. `--config.<...>` sets identity from
 * the app rather than from a checked-in config, so the artifact carries
 * the customer's name and bundle identifier.
 */
export function electronBuilderArgs(options: {
  platformId: string;
  projectDir: string;
  outputDir: string;
  productName: string;
  appId: string;
  version: string;
}): string[] | null {
  const target = ELECTRON_TARGETS[options.platformId];
  if (!target) return null;

  return [
    '--yes',
    'electron-builder',
    target.platform,
    target.arch,
    '--projectDir',
    options.projectDir,
    '--publish',
    'never',
    `--config.productName=${options.productName}`,
    `--config.appId=${options.appId}`,
    `--config.directories.output=${options.outputDir}`,
    `--config.electronVersion=${ELECTRON_VERSION}`,
    // The build's version, not the shell's. Without this every artifact
    // carries the shell's package.json version, so an update looks
    // identical to what it replaces.
    `--config.extraMetadata.version=${options.version}`,
    `--config.buildVersion=${options.version}`,
    // Signing is ours to do afterwards, with the customer's own
    // certificate. Letting electron-builder attempt it would pick up
    // whatever identity happens to be in the build host's keychain.
    '--config.mac.identity=null',
    '--config.win.signAndEditExecutable=false',
  ];
}
