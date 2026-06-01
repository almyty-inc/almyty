import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';

import { SkillGeneratorService } from './skill-generator.service';
import { CliGeneratorService } from './cli-generator.service';
import { CodegenService } from './codegen.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('tools')
@Controller('organizations/:organizationId/tools')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ToolsExportController {
  constructor(
    private readonly skillGeneratorService: SkillGeneratorService,
    private readonly cliGeneratorService: CliGeneratorService,
    private readonly codegenService: CodegenService,
  ) {}

  @Get(':toolId/skill')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate skill file for a tool' })
  @ApiResponse({ status: 200, description: 'Skill generated successfully' })
  async getToolSkill(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Request() req: any,
  ) {
    try {
      const skill = await this.skillGeneratorService.generateToolSkill(toolId, organizationId);

      return {
        success: true,
        data: skill,
        message: 'Skill generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SKILL_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':toolId/cli')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate CLI script for a tool' })
  @ApiQuery({ name: 'format', enum: ['bash', 'node'], required: false })
  @ApiResponse({ status: 200, description: 'CLI script generated successfully' })
  async getToolCli(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Query('format') format: 'bash' | 'node' = 'bash',
    @Request() req: any,
  ) {
    try {
      const cli = await this.cliGeneratorService.generateToolCli(toolId, format, organizationId);

      return {
        success: true,
        data: cli,
        message: 'CLI script generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'CLI_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':toolId/sdk')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate TypeScript SDK for a tool' })
  @ApiResponse({ status: 200, description: 'SDK generated successfully' })
  async getToolSdk(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Request() req: any,
  ) {
    try {
      const sdk = await this.codegenService.generateToolSdk(toolId, organizationId);

      return {
        success: true,
        data: sdk,
        message: 'SDK generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SDK_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
