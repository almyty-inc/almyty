import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

import { AppBuildsService, APP_BUILD_QUEUE } from './app-builds.service';
import { BUN_TARGETS, ProcessToolchainRunner, bunCompileArgs } from './build-toolchain';
import { artifactExtension, type MacPackaging } from './build-targets';
import { BuildStatus } from '../../entities/app-build.entity';

interface BuildJob {
  buildId: string;
  macPackaging?: MacPackaging;
}

/**
 * Turns a queued build into a file someone can download.
 *
 * Each build gets its own scratch directory, removed whatever happens.
 * A build container is shared across tenants, so leaving one customer's
 * bundle identifier, icon and compiled binary lying around for the next
 * build to find is not acceptable even when nothing reads it.
 */
@Processor(APP_BUILD_QUEUE)
export class AppBuildProcessor {
  private readonly logger = new Logger(AppBuildProcessor.name);
  private readonly toolchain = new ProcessToolchainRunner();

  constructor(private readonly builds: AppBuildsService) {}

  @Process()
  async build(job: Job<BuildJob>): Promise<void> {
    const { buildId, macPackaging = 'zip' } = job.data;

    // Unscoped on purpose: this runs from a queue rather than a
    // request, and the id came from a row we wrote.
    const build = await this.builds.findByIdUnscoped(buildId);

    if (!build) {
      this.logger.warn(`Build ${buildId} vanished before it started`);
      return;
    }
    if (build.status !== BuildStatus.QUEUED) {
      // A duplicate delivery. Doing the work twice would overwrite a
      // good artifact with a second copy for no gain.
      this.logger.warn(`Build ${buildId} is ${build.status}, not running it again`);
      return;
    }

    const workDir = join(tmpdir(), `almyty-build-${randomBytes(8).toString('hex')}`);
    let log = '';

    try {
      await this.builds.markRunning(build.id);
      await fs.mkdir(workDir, { recursive: true });

      const bunTarget = BUN_TARGETS[build.platform];
      const extension = artifactExtension(build.target, build.platform, macPackaging);
      const outfile = join(workDir, extension ? `app.${extension}` : 'app');

      if (build.target === 'tui' || build.target === 'binary') {
        // The entry point is ours, not the customer's: an app is
        // configuration over a client we ship, so no customer-authored
        // code enters this compile.
        //
        // Resolved from configuration rather than as an installed
        // dependency, because the backend does not depend on the chat
        // client and should not: it only ever hands the path to bun.
        const entry = await this.resolveClientEntry();
        if (!entry) {
          await this.builds.fail(
            build,
            'The terminal client is not available on this build host. Set APP_BUILD_CLIENT_ENTRY to the built client, or install @almyty/chat.',
            log,
          );
          return;
        }

        const result = await this.toolchain.run(
          'bun',
          bunCompileArgs(entry, bunTarget, outfile),
          { cwd: workDir },
        );
        log = result.output;
        if (!result.ok) {
          await this.builds.fail(build, result.error ?? 'The build failed.', log);
          return;
        }
      } else {
        // Desktop packaging is not wired yet. Failing plainly beats
        // producing an empty file and calling it a release.
        await this.builds.fail(
          build,
          'Desktop packaging is not available on this deployment yet. Terminal apps and standalone binaries build normally.',
          log,
        );
        return;
      }

      const artifact = await fs.readFile(outfile);
      if (artifact.length === 0) {
        await this.builds.fail(build, 'The toolchain produced an empty file.', log);
        return;
      }

      // Signing is not wired yet, so this reports unsigned rather than
      // claiming otherwise. An artifact that says it is signed when it
      // is not is how someone ships a binary macOS will refuse to open.
      await this.builds.succeed(build, artifact, { signed: false, log, macPackaging });
      this.logger.log(`Built ${build.target} for ${build.platform} (${artifact.length} bytes)`);
    } catch (err: any) {
      await this.builds.fail(build, err?.message ?? String(err), log);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Where the terminal client lives on this host.
   *
   * Explicit configuration first, then the monorepo layout, then a
   * normal package resolution. Returns null rather than throwing so the
   * build fails with a sentence naming the fix instead of a stack
   * trace about module resolution.
   */
  private async resolveClientEntry(): Promise<string | null> {
    const configured = process.env.APP_BUILD_CLIENT_ENTRY;
    if (configured) {
      return (await fs.stat(configured).catch(() => null)) ? configured : null;
    }

    const inRepo = join(process.cwd(), '..', 'packages', 'chat-cli', 'dist', 'index.js');
    if (await fs.stat(inRepo).catch(() => null)) return inRepo;

    try {
      return require.resolve('@almyty/chat/dist/index.js', { paths: [process.cwd()] });
    } catch {
      return null;
    }
  }
}
