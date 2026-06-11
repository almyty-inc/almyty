import { OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger, NotFoundException } from '@nestjs/common';
import { Job } from 'bull';

import { ApisService } from '../../apis/apis.service';

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
  };
}

@Processor('schema-import')
export class SchemaImportProcessor {
  private readonly logger = new Logger(SchemaImportProcessor.name);

  constructor(private readonly apisService: ApisService) {}

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
      };
    } catch (error) {
      this.logger.error(`[JOB ${job.id}] Schema import failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Surface job failures. Bull retries (attempts/backoff) mean this fires
   * once per failed attempt; we log a distinct, alert-friendly line only
   * once retries are exhausted so a permanently-failed import is visible
   * to ops instead of silently landing in the (capped, evicted) failed set.
   */
  @OnQueueFailed()
  onFailed(job: Job<SchemaImportJob>, err: Error) {
    const attempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade >= attempts) {
      this.logger.error(
        `[JOB ${job.id}] PERMANENTLY FAILED after ${job.attemptsMade} attempt(s): ` +
          `schema import for API ${job.data?.apiId} (org ${job.data?.organizationId}) — ${err.message}`,
      );
    } else {
      this.logger.warn(
        `[JOB ${job.id}] attempt ${job.attemptsMade}/${attempts} failed, will retry: ${err.message}`,
      );
    }
  }
}
