import { Process, Processor } from '@nestjs/bull';
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
      // payload-carried organizationId, and refuse any job whose
      // (apiId, organizationId) pair doesn't match the stored row.
      // A crafted/injected job with a mismatched pair would
      // otherwise import a schema into the wrong tenant.
      if (!organizationId) {
        throw new NotFoundException(
          `Schema import job ${job.id} rejected: organizationId missing from payload`,
        );
      }
      const api = await this.apisService.findOne(apiId);
      if (!api || api.organizationId !== organizationId) {
        throw new NotFoundException(
          `API ${apiId} not found in organization ${organizationId}`,
        );
      }

      // Update job progress
      await job.progress(10);

      // Import schema (this is the long-running operation)
      const result = await this.apisService.importSchema(
        apiId,
        schemaContent,
        options,
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
}
