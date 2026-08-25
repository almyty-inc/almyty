import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { LessThan, Not, Repository } from 'typeorm';
import { createHash } from 'crypto';

import { AppBuild, BuildStatus } from '../../entities/app-build.entity';
import { AgentApp } from '../../entities/agent-app.entity';
import { DistributionTarget } from '../../entities/agent-app-distribution.entity';
import { StorageService } from '../files/storage.service';
import {
  BUILD_PLATFORMS,
  MacPackaging,
  artifactExtension,
  canBuildHere,
  describeOutcome,
} from './build-targets';
import { ProcessToolchainRunner, toolchainReadiness } from './build-toolchain';

export const APP_BUILD_QUEUE = 'app-build';

/** How long a finished artifact stays downloadable. */
export const ARTIFACT_TTL_DAYS = 30;

/** How long a download link stays valid once minted. */
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

export interface RequestBuildDto {
  target: DistributionTarget;
  platform: string;
  version?: string;
  macPackaging?: MacPackaging;
}

/**
 * Producing a downloadable artifact, and handing back a link.
 *
 * The build runs here rather than on the customer's machine, which is
 * the difference between "download your app" and "install Node and run
 * this command". Signing still uses their own identity, uploaded to the
 * credential vault, the way every CI service does it.
 */
@Injectable()
export class AppBuildsService {
  private readonly logger = new Logger(AppBuildsService.name);
  private readonly toolchain = new ProcessToolchainRunner();

  constructor(
    @InjectRepository(AppBuild)
    private readonly buildRepository: Repository<AppBuild>,
    @InjectRepository(AgentApp)
    private readonly appRepository: Repository<AgentApp>,
    @InjectQueue(APP_BUILD_QUEUE)
    private readonly queue: Queue,
    private readonly storage: StorageService,
  ) {}

  private async findApp(organizationId: string, slug: string): Promise<AgentApp> {
    const app = await this.appRepository.findOne({
      where: { slug: (slug || '').trim().toLowerCase(), organizationId },
    });
    if (!app) throw new NotFoundException('App not found');
    return app;
  }

  /**
   * Queue a build.
   *
   * Everything that can be known up front is checked here rather than
   * inside the job: an unknown platform, a target that produces no
   * file, a missing toolchain. Discovering any of those twenty minutes
   * into a queued job is a worse experience than being told at once.
   */
  async request(
    organizationId: string,
    slug: string,
    dto: RequestBuildDto,
    requestedBy: string | null,
  ): Promise<AppBuild> {
    const app = await this.findApp(organizationId, slug);

    if (!BUILD_PLATFORMS[dto.platform]) {
      throw new BadRequestException(`Unknown platform: ${dto.platform}`);
    }

    const here = canBuildHere(dto.platform, dto.target);
    if (!here.ok) throw new BadRequestException(here.reason ?? 'Cannot build that here.');

    const readiness = await toolchainReadiness(dto.target, this.toolchain);
    if (!readiness.ready) throw new BadRequestException(readiness.reason ?? 'Cannot build that.');

    const build = await this.buildRepository.save(
      this.buildRepository.create({
        organizationId,
        appId: app.id,
        target: dto.target,
        platform: dto.platform,
        status: BuildStatus.QUEUED,
        version: dto.version ?? null,
        requestedBy,
      }),
    );

    await this.queue.add(
      { buildId: build.id, macPackaging: dto.macPackaging ?? 'zip' },
      {
        // A failed build is rarely fixed by running it again: the usual
        // causes are a bad certificate or a missing tool. Retrying would
        // burn minutes of build time to reach the same answer.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    return build;
  }

  async list(organizationId: string, slug: string): Promise<AppBuild[]> {
    const app = await this.findApp(organizationId, slug);
    return this.buildRepository.find({
      where: { appId: app.id, organizationId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  /**
   * Load a build without an organization scope.
   *
   * For the queue worker only. It runs outside a request, and the id it
   * holds came from a row we wrote rather than from a caller, so there
   * is nothing to scope against. Every request path uses findOne, which
   * scopes.
   */
  async findByIdUnscoped(buildId: string): Promise<AppBuild | null> {
    return this.buildRepository.findOne({ where: { id: buildId } });
  }

  async findOne(organizationId: string, buildId: string): Promise<AppBuild> {
    const build = await this.buildRepository.findOne({
      where: { id: buildId, organizationId },
    });
    if (!build) throw new NotFoundException('Build not found');
    return build;
  }

  /**
   * A link the operator can hand out.
   *
   * Short lived and minted per request rather than stored, so a URL
   * that leaks into a chat log or a ticket stops working. The artifact
   * itself expires separately.
   */
  async downloadUrl(organizationId: string, buildId: string): Promise<string> {
    const build = await this.findOne(organizationId, buildId);

    if (build.status !== BuildStatus.SUCCEEDED) {
      throw new BadRequestException(
        build.status === BuildStatus.FAILED
          ? 'That build failed, so there is nothing to download.'
          : 'That build has not finished yet.',
      );
    }
    if (!build.isDownloadable()) {
      throw new BadRequestException(
        'That artifact has expired. Build it again to get a fresh download.',
      );
    }

    // Object storage hands the browser a link and keeps the bytes off
    // the API. A local directory has nothing to sign, so the API serves
    // the file itself rather than returning a URL that resolves to
    // nothing, which is what this used to do.
    if (this.storage.canPresign) {
      return this.storage.getSignedUrl(build.artifactKey!, DOWNLOAD_URL_TTL_SECONDS);
    }

    const app = await this.appRepository.findOne({
      where: { id: build.appId, organizationId },
    });
    if (!app) throw new NotFoundException('That app no longer exists.');
    return `/apps/${app.slug}/builds/${build.id}/artifact`;
  }

  /**
   * The artifact itself, for deployments that cannot presign.
   *
   * Runs the same ownership and expiry checks as the link, because
   * this is the link on those deployments rather than a shortcut past
   * it.
   */
  async artifact(
    organizationId: string,
    buildId: string,
  ): Promise<{ body: Buffer; filename: string }> {
    const build = await this.findOne(organizationId, buildId);

    if (build.status !== BuildStatus.SUCCEEDED) {
      throw new BadRequestException('That build produced nothing to download.');
    }
    if (!build.isDownloadable()) {
      throw new BadRequestException(
        'That artifact has expired. Build it again to get a fresh download.',
      );
    }

    const app = await this.appRepository.findOne({
      where: { id: build.appId, organizationId },
    });
    if (!app) throw new NotFoundException('That app no longer exists.');

    // Name it after the product, not after a row id, because this
    // filename is what lands in someone's Downloads folder.
    const extension = build.artifactKey?.includes('.')
      ? build.artifactKey.slice(build.artifactKey.lastIndexOf('.') + 1)
      : null;
    const stem = `${app.slug}-${build.version ?? '0.0.0'}-${build.platform}`;

    return {
      body: await this.storage.download(build.artifactKey!),
      filename: extension ? `${stem}.${extension}` : stem,
    };
  }

  /** Where an artifact lives. Scoped by org so keys cannot collide. */
  static artifactKey(
    build: Pick<AppBuild, 'organizationId' | 'appId' | 'id'>,
    extension: string | null,
  ) {
    const base = `app-builds/${build.organizationId}/${build.appId}/${build.id}`;
    return extension ? `${base}.${extension}` : base;
  }

  async markRunning(buildId: string): Promise<void> {
    await this.buildRepository.update(
      { id: buildId },
      { status: BuildStatus.RUNNING, startedAt: new Date() },
    );
  }

  /**
   * Store the artifact and mark the build done.
   *
   * The checksum is recorded so a download can be verified, which
   * matters more than usual here: this is an executable someone will
   * run on their own machine.
   */
  async succeed(
    build: AppBuild,
    artifact: Buffer,
    options: {
      signed: boolean;
      log: string;
      macPackaging?: MacPackaging;
      /** Why it is unsigned, when it could have been signed. */
      signingNote?: string | null;
    },
  ): Promise<AppBuild> {
    // Depends on the target as well as the platform: a terminal app is
    // a bare executable, not a bundle to zip.
    const extension = artifactExtension(
      build.target,
      build.platform,
      options.macPackaging ?? 'zip',
    );

    const key = AppBuildsService.artifactKey(build, extension);
    await this.storage.upload(key, artifact, 'application/octet-stream');

    const expires = new Date();
    expires.setDate(expires.getDate() + ARTIFACT_TTL_DAYS);

    build.status = BuildStatus.SUCCEEDED;
    build.artifactKey = key;
    build.artifactBytes = String(artifact.length);
    build.checksum = createHash('sha256').update(artifact).digest('hex');
    build.signed = options.signed;
    build.signingNote = options.signingNote ?? null;
    build.log = options.log;
    build.error = null;
    build.finishedAt = new Date();
    build.artifactExpiresAt = expires;

    return this.buildRepository.save(build);
  }

  async fail(build: AppBuild, error: string, log: string): Promise<AppBuild> {
    build.status = BuildStatus.FAILED;
    build.error = error;
    build.log = log;
    build.finishedAt = new Date();
    return this.buildRepository.save(build);
  }

  /**
   * Drop artifacts past their expiry.
   *
   * Deletes the file but keeps the row: the history of what was built,
   * and whether it was signed, is what a later support question needs,
   * and it costs nothing to keep.
   */
  async sweepExpiredArtifacts(now: Date = new Date()): Promise<number> {
    const expired = await this.buildRepository.find({
      where: {
        status: BuildStatus.SUCCEEDED,
        artifactExpiresAt: LessThan(now),
        artifactKey: Not(null as any),
      },
      take: 200,
    });

    let removed = 0;
    for (const build of expired) {
      try {
        await this.storage.delete?.(build.artifactKey!);
      } catch (err: any) {
        // A file already gone is the expected case on a retry, so it
        // must not stop the sweep clearing the row's pointer.
        this.logger.warn(`Could not delete artifact ${build.artifactKey}: ${err?.message ?? err}`);
      }
      build.artifactKey = null;
      await this.buildRepository.save(build);
      removed += 1;
    }
    return removed;
  }

  /** What the operator will get, for showing before they commit. */
  preview(platform: string, willBeSigned: boolean, macPackaging: MacPackaging = 'zip') {
    return describeOutcome(platform, willBeSigned, macPackaging);
  }
}
