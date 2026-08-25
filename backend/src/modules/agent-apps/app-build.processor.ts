import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

import { AppBuildsService, APP_BUILD_QUEUE } from './app-builds.service';
import { BuildSignerService } from './build-signer.service';
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
/**
 * One line an operator can read, from whatever the toolchain threw.
 *
 * Node errors arrive as a message plus a require stack of absolute
 * paths. Those say nothing to the person who pressed Build and describe
 * the build host to anyone who can see the panel.
 */
export function operatorMessage(err: any): string {
  const raw = (err?.message ?? String(err ?? '')).trim();
  const firstLine = raw.split('\n')[0].trim();
  if (!firstLine) return 'The build failed.';

  // Only ABSOLUTE paths become a placeholder. A module specifier like
  // "@almyty/chat/dist/index.js" says which dependency is missing and
  // reveals nothing about the host, so the lookbehind keeps it.
  return firstLine
    .replace(/(?<![\w@.-])(?:[A-Za-z]:)?[\\/](?:[\w.@-]+[\\/])*[\w.@-]+/g, '<path>')
    .slice(0, 500);
}

@Processor(APP_BUILD_QUEUE)
export class AppBuildProcessor {
  private readonly logger = new Logger(AppBuildProcessor.name);
  private readonly toolchain = new ProcessToolchainRunner();

  constructor(
    private readonly builds: AppBuildsService,
    private readonly signer: BuildSignerService,
  ) {}

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

      // Signed with the customer's own certificate when a distribution
      // names one. `signed` records what the tool actually did rather
      // than what was attempted: an artifact that claims a signature it
      // does not carry is how someone ships a binary the target OS
      // refuses to open.
      const signing = await this.signer.sign({
        appId: build.appId,
        target: build.target,
        platform: build.platform,
        artifactPath: outfile,
        workDir,
        runner: this.toolchain,
      });

      if (signing.error) log = `${log}\n${signing.error}`.trim();

      // Re-read after signing: the tools rewrite the file in place, so
      // the bytes read before this are the unsigned ones.
      const finished = signing.signed ? await fs.readFile(outfile) : artifact;

      await this.builds.succeed(build, finished, {
        signed: signing.signed,
        // Kept out of `error`, which means the build failed. This one
        // succeeded and is simply not signed, and the operator needs to
        // know which of those it is.
        signingNote: signing.error,
        log,
        macPackaging,
      });
      this.logger.log(
        `Built ${build.target} for ${build.platform} (${finished.length} bytes, ${
          signing.signed ? 'signed' : 'unsigned'
        })`,
      );
    } catch (err: any) {
      // The full text goes to the log, which stays server side. What
      // reaches the operator is one line with host paths removed: a
      // build panel is not the place to publish the layout of the
      // machine the build ran on.
      await this.builds.fail(build, operatorMessage(err), log);
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
