import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

import { ApisService } from '../../apis/apis.service';

export interface SchemaImportJob {
  apiId: string;
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
    const { apiId, schemaContent, options } = job.data;

    this.logger.log(`[JOB ${job.id}] Starting schema import for API ${apiId}`);

    try {
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
