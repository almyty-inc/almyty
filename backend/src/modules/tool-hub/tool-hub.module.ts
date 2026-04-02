import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ToolTemplate } from '../../entities/tool-template.entity';
import { Tool } from '../../entities/tool.entity';
import { Api } from '../../entities/api.entity';
import { ToolHubService } from './tool-hub.service';
import { ToolHubController } from './tool-hub.controller';
import { ToolsModule } from '../tools/tools.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ToolTemplate, Tool, Api]),
    forwardRef(() => ToolsModule),
  ],
  providers: [ToolHubService],
  controllers: [ToolHubController],
  exports: [ToolHubService],
})
export class ToolHubModule {}
