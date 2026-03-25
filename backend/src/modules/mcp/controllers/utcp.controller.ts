import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Request,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
  Header,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { UtcpService } from '../utcp.service';
import { 
  UtcpExecutionContext,
  UtcpDiscoveryInfo,
  UtcpManual,
} from '../types/utcp.types';

@Controller('utcp')
export class UtcpController {
  private readonly logger = new Logger(UtcpController.name);

  constructor(private readonly utcpService: UtcpService) {}

  // UTCP Discovery endpoint
  @Get('/.well-known/utcp')
  @Header('Content-Type', 'application/json')
  async discovery(): Promise<UtcpDiscoveryInfo> {
    return this.utcpService.getDiscoveryInfo('global');
  }

  // Organization-specific discovery
  @Get('/:organizationId/.well-known/utcp')
  @UseGuards(JwtAuthGuard)
  @Header('Content-Type', 'application/json')
  async organizationDiscovery(
    @Param('organizationId') organizationId: string,
    @Request() req,
  ): Promise<UtcpDiscoveryInfo> {
    // Verify access to organization
    if (req.user?.currentOrganizationId !== organizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    return this.utcpService.getDiscoveryInfo(organizationId);
  }

  // Get UTCP Manual (the core UTCP feature)
  @Get('/:organizationId/manual')
  @UseGuards(JwtAuthGuard)
  @Header('Content-Type', 'application/json')
  async getManual(
    @Param('organizationId') organizationId: string,
    @Request() req,
  ): Promise<UtcpManual> {
    // Verify access to organization
    if (req.user?.currentOrganizationId !== organizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    const manual = await this.utcpService.generateManual(organizationId);
    
    this.logger.log(`UTCP manual generated for org ${organizationId}: ${manual.tools.length} tools, ${manual.callTemplates.length} templates`);
    
    return manual;
  }

  // Get manual for specific tool
  @Get('/:organizationId/tools/:toolId/manual')
  @UseGuards(JwtAuthGuard)
  @Header('Content-Type', 'application/json')
  async getToolManual(
    @Param('organizationId') organizationId: string,
    @Param('toolId') toolId: string,
    @Request() req,
  ) {
    // Verify access to organization
    if (req.user?.currentOrganizationId !== organizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    return this.utcpService.getToolManual(toolId, organizationId);
  }

  // Execute tool via UTCP (Proxy Mode)
  @Post('/:organizationId/execute')
  @UseGuards(JwtAuthGuard)
  @Header('Content-Type', 'application/json')
  async executeUtcpTool(
    @Param('organizationId') organizationId: string,
    @Body() context: UtcpExecutionContext,
    @Request() req,
  ) {
    // Verify access to organization
    if (req.user?.currentOrganizationId !== organizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    this.logger.debug(`UTCP tool execution: ${context.toolId} for org ${organizationId}`);

    return this.utcpService.executeUtcpTool(context, organizationId);
  }

  // Validate UTCP manual
  @Post('/:organizationId/validate')
  @UseGuards(JwtAuthGuard)
  async validateManual(
    @Param('organizationId') organizationId: string,
    @Body() manual: UtcpManual,
    @Request() req,
  ) {
    // Verify access to organization
    if (req.user?.currentOrganizationId !== organizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    return this.utcpService.validateManual(manual);
  }

  // Get UTCP capabilities
  @Get('/capabilities')
  @Header('Content-Type', 'application/json')
  async getCapabilities() {
    return {
      protocol: 'utcp',
      version: '1.0.0',
      server: 'almyty',
      capabilities: {
        manualGeneration: true,
        directCalling: true,
        proxyMode: true,
        authenticationSchemes: ['none', 'api_key', 'bearer', 'basic', 'oauth2'],
        protocols: ['http', 'websocket'],
        formats: ['json', 'xml', 'yaml'],
        apiFormats: ['openapi', 'graphql', 'soap', 'protobuf'],
      },
      features: {
        manualGeneration: true,
        directCalling: true,
        autoToolGeneration: true,
        multiProtocolOutput: true,
        organizationIsolation: true,
      },
    };
  }

  // Health check
  @Get('/health')
  async health() {
    return {
      protocol: 'utcp',
      status: 'healthy',
      server: 'almyty',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  // Export manual as different formats
  @Get('/:organizationId/manual/export/:format')
  @UseGuards(JwtAuthGuard)
  async exportManual(
    @Param('organizationId') organizationId: string,
    @Param('format') format: 'json' | 'yaml' | 'markdown',
    @Request() req,
  ) {
    // Verify access to organization
    if (req.user?.currentOrganizationId !== organizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    const manual = await this.utcpService.generateManual(organizationId);

    switch (format) {
      case 'json':
        return manual;
        
      case 'yaml':
        // TODO: Convert to YAML format
        throw new HttpException('YAML export not implemented yet', HttpStatus.NOT_IMPLEMENTED);
        
      case 'markdown':
        // TODO: Generate markdown documentation
        throw new HttpException('Markdown export not implemented yet', HttpStatus.NOT_IMPLEMENTED);
        
      default:
        throw new HttpException('Unsupported export format', HttpStatus.BAD_REQUEST);
    }
  }

  // Get statistics about UTCP usage
  @Get('/:organizationId/stats')
  @UseGuards(JwtAuthGuard)
  async getUtcpStats(
    @Param('organizationId') organizationId: string,
    @Request() req,
  ) {
    // Verify access to organization
    if (req.user?.currentOrganizationId !== organizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }

    const manual = await this.utcpService.generateManual(organizationId);

    return {
      organizationId,
      manual: {
        version: manual.version,
        toolCount: manual.tools.length,
        callTemplateCount: manual.callTemplates.length,
        authSchemeCount: manual.authentication?.length || 0,
      },
      features: {
        directCalling: manual.callTemplates.length,
        proxyMode: manual.tools.length,
        autoGenerated: manual.tools.filter(t => t.metadata?.autoGenerated).length,
      },
      generatedAt: manual.metadata?.generatedAt,
    };
  }
}