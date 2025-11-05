import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SchemaImportProcessor } from './processors/schema-import.processor';
import { ApisService } from '../apis/apis.service';
import { ToolsModule} from '../tools/tools.module';
import { SchemaParserModule } from '../schema-parser/schema-parser.module';

// Entities
import { Api } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Organization } from '../../entities/organization.entity';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'schema-import',
    }),
    TypeOrmModule.forFeature([
      Api,
      ApiSchema,
      Operation,
      Resource,
      Organization,
    ]),
    SchemaParserModule,
    ToolsModule,
  ],
  providers: [SchemaImportProcessor, ApisService],
  exports: [BullModule, SchemaImportProcessor],
})
export class JobsModule {}
