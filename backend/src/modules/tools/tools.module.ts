import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Tool } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { ToolsOperationHelper } from './tools-operation.helper';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Operation } from '../../entities/operation.entity';
import { JsonSchema } from '../../entities/json-schema.entity';
import { Api } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { Credential } from '../../entities/credential.entity';

import { ToolsService } from './tools.service';
import { ToolGeneratorService } from './tool-generator.service';
import { ToolExecutorService } from './tool-executor.service';
import { ToolHttpExecutor } from './executors/tool-http.executor';
import { ToolProtocolExecutor } from './executors/tool-protocol.executor';
import { ToolScriptExecutor } from './executors/tool-script.executor';
import { GrpcCallerService } from './executors/grpc-caller.service';
import { ToolAuthService } from './services/tool-auth.service';
import { SkillGeneratorService } from './skill-generator.service';
import { CliGeneratorService } from './cli-generator.service';
import { CodegenService } from './codegen.service';
import { ToolsController } from './tools.controller';
import { ToolsExportController } from './tools-export.controller';

import { JsonSchemaTranslatorModule } from '../json-schema-translator/json-schema-translator.module';
import { NodeSandboxModule } from './node-sandbox/node-sandbox.module';

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
      ApiSchema,
      Gateway,
      GatewayTool,
      User,
      Organization,
      Credential,
    ]),
    JsonSchemaTranslatorModule,
    NodeSandboxModule,
  ],
  providers: [
    ToolsService,
    ToolsOperationHelper,
    ToolGeneratorService,
    ToolExecutorService,
    ToolHttpExecutor,
    ToolProtocolExecutor,
    ToolScriptExecutor,
    GrpcCallerService,
    ToolAuthService,
    SkillGeneratorService,
    CliGeneratorService,
    CodegenService,
  ],
  controllers: [ToolsController, ToolsExportController],
  exports: [
    ToolsService,
    ToolGeneratorService,
    ToolExecutorService,
    SkillGeneratorService,
    CliGeneratorService,
    CodegenService,
  ],
})
export class ToolsModule {}