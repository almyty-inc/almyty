import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Tool } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { ToolsOperationHelper } from './tools-operation.helper';
import { ToolsStatsHelper } from './tools-stats.helper';
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
import { ToolCacheRateLimitHelper } from './tool-cache-rate-limit.helper';
import { ToolStatsHelper } from './tool-stats.helper';
import { ToolHttpExecutor } from './executors/tool-http.executor';
import { ToolProtocolExecutor } from './executors/tool-protocol.executor';
import { ToolGrpcExecutor } from './executors/tool-grpc.executor';
import { ToolScriptExecutor } from './executors/tool-script.executor';
import { GrpcCallerService } from './executors/grpc-caller.service';
import { ToolAuthService } from './services/tool-auth.service';
import { SkillGeneratorService } from './skill-generator.service';
import { SkillRendererHelper } from './skill-renderer.helper';
import { CliGeneratorService } from './cli-generator.service';
import { CodegenService } from './codegen.service';
import { ToolsController } from './tools.controller';
import { ToolsExportController } from './tools-export.controller';

import { JsonSchemaTranslatorModule } from '../json-schema-translator/json-schema-translator.module';
import { NodeSandboxModule } from './node-sandbox/node-sandbox.module';
import { MemoryModule } from '../memory/memory.module';
import { RunnerModule } from '../runner/runner.module';
import { AuthorizationModule } from '../../common/authorization/authorization.module';

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
    RunnerModule,
    forwardRef(() => MemoryModule),
    AuthorizationModule,
  ],
  providers: [
    ToolsService,
    ToolsOperationHelper,
    ToolsStatsHelper,
    ToolGeneratorService,
    ToolExecutorService,
    ToolHttpExecutor,
    ToolProtocolExecutor,
    ToolGrpcExecutor,
    ToolCacheRateLimitHelper,
    ToolStatsHelper,
    ToolScriptExecutor,
    GrpcCallerService,
    ToolAuthService,
    SkillGeneratorService,
    SkillRendererHelper,
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