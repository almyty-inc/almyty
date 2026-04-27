import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  UseGuards,
  Header,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { UtcpService } from '../utcp.service';
import { UtcpDiscoveryInfo, UtcpManual, UtcpExecutionContext } from '../types/utcp.types';

/**
 * Legacy global UTCP endpoints. The canonical surface is the unified
 * gateway endpoint at `/{orgSlug}/{gatewaySlug}/{action}` — these
 * routes serve a few static descriptors and an org-scoped manual
 * for SDK / tooling that hasn't been pointed at the gateway yet.
 */
@Controller('utcp')
export class UtcpController {
  private readonly logger = new Logger(UtcpController.name);

  constructor(private readonly utcpService: UtcpService) {}

  @Get('/.well-known/utcp')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Content-Type', 'application/json')
  discovery(@Req() req: Request): UtcpDiscoveryInfo {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return this.utcpService.getDiscoveryInfo({
      organizationId: 'global',
      baseUrl,
      orgSlug: 'global',
    });
  }

  @Get('/capabilities')
  @Header('Content-Type', 'application/json')
  capabilities() {
    return {
      protocol: 'utcp',
      utcp_version: '1.0.0',
      server: 'almyty',
      capabilities: {
        manualGeneration: true,
        proxyMode: true,
        authenticationSchemes: ['none', 'api_key', 'basic', 'oauth2'],
        protocols: ['http'],
        formats: ['json'],
        apiFormats: ['openapi', 'graphql', 'soap', 'protobuf'],
      },
    };
  }

  /**
   * Health response stays minimal. `process.uptime()` and timestamps
   * leak deploy timing to anonymous callers, which helps attackers
   * align attempts with rolling restarts.
   */
  @Get('/health')
  health() {
    return {
      protocol: 'utcp',
      status: 'healthy',
      utcp_version: '1.0.0',
    };
  }

  @Get('/:organizationId/manual')
  @UseGuards(JwtAuthGuard)
  @Header('Content-Type', 'application/json')
  async getManual(
    @Param('organizationId') organizationId: string,
    @Req() req: any,
  ): Promise<UtcpManual> {
    if (req.user?.currentOrganizationId !== organizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }
    return this.utcpService.generateManual({ organizationId });
  }

  @Post('/:organizationId/execute')
  @UseGuards(JwtAuthGuard)
  @Header('Content-Type', 'application/json')
  async execute(
    @Param('organizationId') organizationId: string,
    @Body() context: UtcpExecutionContext,
    @Req() req: any,
  ) {
    if (req.user?.currentOrganizationId !== organizationId) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }
    return this.utcpService.executeUtcpTool(context, organizationId, req.user?.id);
  }
}
