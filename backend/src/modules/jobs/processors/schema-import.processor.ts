import { Process, Processor } from '@nestjs/bull';
import { Logger, NotFoundException } from '@nestjs/common';
import { Job } from 'bull';

import { ApisService } from '../../apis/apis.service';

export interface SchemaImportJob {
  apiId: string;
  /** Set by the controller when the job is enqueued. Older jobs (created
   *  before this field existed) will have it undefined; the worker treats
   *  that case as "skip the cross-check" so we don't break in-flight imports
   *  during the upgrade. */
  organizationId?: string;
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
      // Defence-in-depth: verify the api still exists and (if the job
      // payload carries an org) still belongs to that org. If a job is
      // somehow injected with a mismatched (apiId, organizationId) pair,
      // refuse to run it instead of importing into the wrong tenant.
      if (organizationId) {
        const api = await this.apisService.findOne(apiId);
        if (!api || api.organizationId !== organizationId) {
          throw new NotFoundException(
            `API ${apiId} not found in organization ${organizationId}`,
          );
        }
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
