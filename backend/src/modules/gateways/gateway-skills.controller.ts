import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';

import { GatewaysService } from './gateways.service';
import { GatewayToolService } from './gateway-tool.service';
import { SkillGeneratorService } from '../tools/skill-generator.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { CliGeneratorService } from '../tools/cli-generator.service';
import { CodegenService } from '../tools/codegen.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { batchAsync } from '../../common/utils/batch-async';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('gateways')
@ApiTags('Gateways')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class GatewaySkillsController {
  private readonly logger = new Logger(GatewaySkillsController.name);

  constructor(
    private readonly gatewaysService: GatewaysService,
    private readonly gatewayToolService: GatewayToolService,
    private readonly skillGeneratorService: SkillGeneratorService,
    private readonly toolExecutorService: ToolExecutorService,
    private readonly cliGeneratorService: CliGeneratorService,
    private readonly codegenService: CodegenService,
  ) {}

  // === Gateway Export Endpoints ===

  @Get(':gatewayId/skills')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate skill bundle for all tools in a gateway' })
  @ApiResponse({ status: 200, description: 'Gateway skills generated successfully' })
  async getGatewaySkills(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const skills = await this.skillGeneratorService.generateGatewaySkills(gatewayId, organizationId);
      return {
        success: true,
        data: skills,
        message: 'Gateway skills generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_SKILLS_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/skills/individual')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate individual SKILL.md files for each tool in a gateway' })
  @ApiResponse({ status: 200, description: 'Individual skills generated successfully' })
  async getGatewayIndividualSkills(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      let context: { orgSlug?: string; gatewaySlug?: string } | undefined;
      const gateway = await this.gatewaysService.getGateway(gatewayId, organizationId, false);
      const gateways = await this.gatewaysService.getAllUserGateways(organizationId);
      const org = gateways[0]?.organization;
      if (org && gateway) {
        const orgSlug = org.slug || org.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
        const gatewaySlug = gateway.endpoint?.replace(/^\//, '') || gateway.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        context = { orgSlug, gatewaySlug };
      }

      const skills = await this.skillGeneratorService.generateIndividualSkills(gatewayId, organizationId, context);
      return {
        success: true,
        data: { skills },
        message: `Generated ${skills.length} individual skills`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_INDIVIDUAL_SKILLS_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':gatewayId/skills/:toolId/execute')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Execute a skill via CLI' })
  @ApiParam({ name: 'gatewayId', description: 'Gateway ID' })
  @ApiParam({ name: 'toolId', description: 'Tool ID' })
  @ApiResponse({ status: 200, description: 'Skill executed successfully' })
  @ApiResponse({ status: 404, description: 'Tool not found in gateway' })
  async executeSkill(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Body() body: { parameters: Record<string, any> },
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const userId = req.user.sub || req.user.id;

      // Verify the tool belongs to the gateway
      const gateway = await this.gatewaysService.getGateway(gatewayId, organizationId, true);
      const gatewayTool = gateway.tools?.find(gt => gt.toolId === toolId && gt.isActive);
      if (!gatewayTool) {
        throw new HttpException(
          { success: false, message: 'Tool not found in this gateway or is inactive', error: 'TOOL_NOT_IN_GATEWAY' },
          HttpStatus.NOT_FOUND,
        );
      }

      const result = await this.toolExecutorService.executeTool(
        toolId,
        body.parameters || {},
        { userId, organizationId },
      );

      // Increment gateway request counter
      try {
        await this.gatewaysService.incrementRequestCount(gatewayId, result.success);
      } catch {}

      return {
        success: true,
        data: result,
        message: result.success ? 'Skill executed successfully' : 'Skill execution failed',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SKILL_EXECUTION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/cli-bundle')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate CLI bundle for all tools in a gateway' })
  @ApiResponse({ status: 200, description: 'Gateway CLI bundle generated successfully' })
  async getGatewayCliBundle(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Query('format') format: 'bash' | 'node' = 'bash',
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const cli = await this.cliGeneratorService.generateGatewayCliBunde(gatewayId, format, organizationId);
      return {
        success: true,
        data: cli,
        message: 'Gateway CLI bundle generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_CLI_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/sdk')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate TypeScript SDK for all tools in a gateway' })
  @ApiResponse({ status: 200, description: 'Gateway SDK generated successfully' })
  async getGatewaySdk(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }
      const sdk = await this.codegenService.generateGatewaySdk(gatewayId, organizationId);
      return {
        success: true,
        data: sdk,
        message: 'Gateway SDK generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_SDK_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
