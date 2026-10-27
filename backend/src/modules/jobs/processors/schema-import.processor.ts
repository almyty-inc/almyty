import { OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bull';

import { Api } from '../../../entities/api.entity';
import { ApisService } from '../../apis/apis.service';
import { ApisSdkAnalysisHelper, SDK_ANALYSIS_JOB, type SdkAnalysisJob } from '../../apis/apis-sdk-analysis.helper';
import { ToolQuotaExceededException } from '../../tools/tool-quota';

export interface SchemaImportJob {
  apiId: string;
  /**
   * Required. Set by the controller when the job is enqueued. Any
   * job payload missing this field is rejected by the processor
   * rather than silently bypassing the cross-tenant check — during
   * the original rollout this was optional to accommodate in-flight
   * jobs that predated the field, but that grace window has long
   * since closed and an optional org field is now a footgun (a
   * crafted job payload with no org could bypass tenant validation).
   */
  organizationId: string;
  schemaContent: string;
  options: {
    fileName?: string;
    description?: string;
    generateTools?: boolean;
    /** Who queued the import; its generated tools are recorded as theirs. */
    createdBy?: string | null;
  };
}

/** Make tools from an API's active operations (`generate`): the second half of an import over the per-schema limit. */
export interface ToolGenerateJob {
  apiId: string;
  organizationId: string;
  createdBy?: string | null;
}

@Processor('schema-import')
export class SchemaImportProcessor {
  private readonly logger = new Logger(SchemaImportProcessor.name);

  constructor(
    private readonly apisService: ApisService,
    @InjectRepository(Api)
    private readonly apiRepository: Repository<Api>,
    @Optional() private readonly sdkAnalysis?: ApisSdkAnalysisHelper,
  ) {}

  @Process('import')
  async handleSchemaImport(job: Job<SchemaImportJob>) {
    const { apiId, organizationId, schemaContent, options } = job.data;

    this.logger.log(`[JOB ${job.id}] Starting schema import for API ${apiId}`);

    try {
      // Mandatory tenant check: refuse to run any job without a
      // payload-carried organizationId. The service layer's
      // findOne now enforces tenancy via the WHERE clause so a
      // mismatched pair will return null without leaking anything.
      if (!organizationId) {
        throw new NotFoundException(
          `Schema import job ${job.id} rejected: organizationId missing from payload`,
        );
      }
      const api = await this.apisService.findOne(apiId, organizationId);
      if (!api) {
        throw new NotFoundException(
          `API ${apiId} not found in organization ${organizationId}`,
        );
      }

      // Update job progress
      await job.progress(10);

      // Import schema (this is the long-running operation). Pass a
      // progress callback so each tool-gen batch can refresh the
      // BullMQ lock — without this, large specs (Stripe ~7.7 MB,
      // 600+ ops) trigger the stalled-job watchdog mid-run.
      const result = await this.apisService.importSchema(
        apiId,
        schemaContent,
        organizationId,
        options,
        (pct) => job.progress(Math.max(10, Math.min(99, pct))),
      );

      await job.progress(100);

      this.logger.log(`[JOB ${job.id}] Schema import completed successfully`);

      return {
        success: true,
        api: result.api,
        schema: result.schema,
        operationCount: result.operations.length,
        toolCount: result.tools?.length || 0,
        // Over the per-schema limit: imported, no tools yet, pick a subset.
        ...(result.selectionRequired ? { selectionRequired: result.selectionRequired } : {}),
      };
    } catch (error) {
      this.logger.error(`[JOB ${job.id}] Schema import failed: ${error.message}`, error.stack);
      this.discardIfPermanent(job, error);
      throw error;
    }
  }

  /**
   * Analyse an SDK API's npm packages into `api.sdkMaps`. Same queue as
   * schema imports: both are "read what this API offers", both are slow.
   * The helper records progress and failure on the API row itself.
   */
  @Process(SDK_ANALYSIS_JOB)
  async handleSdkAnalysis(job: Job<SdkAnalysisJob>) {
    const { apiId, organizationId } = job.data ?? ({} as SdkAnalysisJob);
    if (!organizationId) {
      throw new NotFoundException(`SDK analysis job ${job.id} rejected: organizationId missing from payload`);
    }
    if (!this.sdkAnalysis) throw new Error('SDK analysis is not available in this process');
    const state = await this.sdkAnalysis.analyse(apiId, organizationId, (pct) => job.progress(pct));
    this.logger.log(`[JOB ${job.id}] SDK analysis for API ${apiId}: ${state.packages?.length ?? 0} package(s)`);
    return { success: true, ...state };
  }

  /**
   * Make tools from the operations picked after an import that was over the
   * per-schema limit (`POST /apis/:id/operations/selection` marked them
   * active). Polled through the same import-status route.
   */
  @Process('generate')
  async handleGenerateTools(job: Job<ToolGenerateJob>) {
    const { apiId, organizationId, createdBy } = job.data;
    try {
      if (!organizationId) {
        throw new NotFoundException(`Tool generation job ${job.id} rejected: organizationId missing from payload`);
      }
      await job.progress(10);
      const result = await this.apisService.generateToolsFromApi(
        apiId,
        organizationId,
        undefined,
        (done, total) => job.progress(10 + Math.floor((done / Math.max(total, 1)) * 89)),
        createdBy ?? null,
      );
      await job.progress(100);
      return { success: true, operationCount: result.total - result.skippedInactive, toolCount: result.generated };
    } catch (error) {
      this.logger.error(`[JOB ${job.id}] Tool generation failed: ${error.message}`, error.stack);
      this.discardIfPermanent(job, error);
      throw error;
    }
  }

  /**
   * A quota refusal is the same on every attempt: fail the job now rather
   * than retrying it twice more with backoff, which kept "Finish connecting"
   * spinning for many minutes before it could say why.
   */
  private discardIfPermanent(job: Job, error: unknown): void {
    if (error instanceof ToolQuotaExceededException) job.discard();
  }

  /**
   * Surface job failures. Bull retries (attempts/backoff) mean this fires
   * once per failed attempt; we log a distinct, alert-friendly line only
   * once retries are exhausted so a permanently-failed import is visible
   * to ops instead of silently landing in the (capped, evicted) failed set.
   *
   * On the last attempt the reason is also written to the API row. It
   * used to exist only as `job.failedReason` in Redis, which
   * `removeOnFail: 50` evicts after fifty further failures and a Redis
   * restart loses outright — so "why did my import fail?" had no durable
   * answer for a minutes-long operation.
   */
  @OnQueueFailed()
  async onFailed(job: Job<SchemaImportJob>, err: Error): Promise<void> {
    const attempts = job.opts?.attempts ?? 1;
    // A discarded job (discardIfPermanent) gets no further attempt either.
    const discarded = (job as Job & { isDiscarded?: () => boolean }).isDiscarded?.() === true;
    if (job.attemptsMade >= attempts || discarded) {
      this.logger.error(
        `[JOB ${job.id}] PERMANENTLY FAILED after ${job.attemptsMade} attempt(s): ` +
          `schema import for API ${job.data?.apiId} (org ${job.data?.organizationId}) — ${err.message}`,
      );
      await this.recordImportFailure(job, err);
    } else {
      this.logger.warn(
        `[JOB ${job.id}] attempt ${job.attemptsMade}/${attempts} failed, will retry: ${err.message}`,
      );
    }
  }

  private async recordImportFailure(job: Job<SchemaImportJob>, err: Error): Promise<void> {
    const { apiId, organizationId } = job.data ?? ({} as SchemaImportJob);
    if (!apiId || !organizationId) return;
    try {
      await this.apiRepository.update(
        { id: apiId, organizationId },
        {
          lastImportError: (err?.message || 'Unknown import error').slice(0, 4000),
          lastImportFailedAt: new Date(),
        },
      );
    } catch (writeError: any) {
      // A failure handler must never throw: that would replace a recorded
      // failure with an unrecorded one.
      this.logger.error(
        `[JOB ${job.id}] could not persist the import failure for API ${apiId}: ${writeError?.message}`,
      );
    }
  }
}
