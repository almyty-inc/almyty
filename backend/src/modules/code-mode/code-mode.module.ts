import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CodeExecution } from '../../entities/code-execution.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { NodeSandboxModule } from '../tools/node-sandbox/node-sandbox.module';
import { ToolsModule } from '../tools/tools.module';
import { ToolDiscoveryModule } from '../tool-discovery/tool-discovery.module';
import { CodeModeService } from './code-mode.service';

/**
 * Code mode (docs/design/code-mode.md, parts C and D): run_code, its
 * sandbox profile, the broker and the traces. Autonomous agents use it in
 * the `code` tool mode; the run view reads the traces.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CodeExecution, ToolExecution]),
    NodeSandboxModule,
    forwardRef(() => ToolsModule),
    forwardRef(() => ToolDiscoveryModule),
  ],
  providers: [CodeModeService],
  exports: [CodeModeService],
})
export class CodeModeModule {}
