import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SchemaImportProcessor } from './processors/schema-import.processor';
import { ProviderHealthProcessor, PROVIDER_HEALTH_QUEUE } from './processors/provider-health.processor';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { ApisModule } from '../apis/apis.module';
import { ToolsModule} from '../tools/tools.module';
import { SchemaParserModule } from '../schema-parser/schema-parser.module';

// Entities
import { Api } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Organization } from '../../entities/organization.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'schema-import',
      // Real-world OpenAPI specs (Stripe ~7.7 MB, GitHub REST ~12 MB)
      // can take longer than the default 30 s lock duration to parse
      // + persist + generate hundreds of tool rows. With the default
      // lock, BullMQ kills the job as "stalled" before generation
      // finishes and the import silently produces zero tools. The
      // processor also calls `job.progress()` periodically inside
      // generateToolsFromApi to refresh the lock — the larger
      // ceiling here is the safety net for a parse phase that
      // can't pause to heartbeat.
      settings: {
        lockDuration: 5 * 60_000, // 5 min — covers parse + tool gen on large specs
        stalledInterval: 60_000,
        maxStalledCount: 1,
      },
    }),
    TypeOrmModule.forFeature([
      Api,
      ApiSchema,
      Operation,
      Resource,
      Organization,
      LlmProvider,
    ]),
    // Periodic provider key-health re-check (P1 T1.7). Registration is
    // cheap; the repeatable job is only scheduled when
    // PROVIDER_HEALTH_RECHECK_CRON is set (see the processor).
    BullModule.registerQueue({ name: PROVIDER_HEALTH_QUEUE }),
    SchemaParserModule,
    ToolsModule,
    forwardRef(() => ApisModule),
    LlmProvidersModule,
  ],
  providers: [SchemaImportProcessor, ProviderHealthProcessor],
  exports: [BullModule, SchemaImportProcessor],
})
export class JobsModule {}
