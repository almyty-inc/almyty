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
