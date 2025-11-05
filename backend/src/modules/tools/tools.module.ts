import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Tool } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Operation } from '../../entities/operation.entity';
import { JsonSchema } from '../../entities/json-schema.entity';
import { Api } from '../../entities/api.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';

import { ToolsService } from './tools.service';
import { ToolGeneratorService } from './tool-generator.service';
import { ToolExecutorService } from './tool-executor.service';
import { ToolsController } from './tools.controller';

import { JsonSchemaTranslatorModule } from '../json-schema-translator/json-schema-translator.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tool,
      ToolVersion,
      ToolCategory,
      ToolExecution,
      Operation,
      JsonSchema,
      Api,
      GatewayTool,
      User,
      Organization,
    ]),
    JsonSchemaTranslatorModule,
  ],
  providers: [ToolsService, ToolGeneratorService, ToolExecutorService],
  controllers: [ToolsController],
  exports: [ToolsService, ToolGeneratorService, ToolExecutorService],
})
export class ToolsModule {}