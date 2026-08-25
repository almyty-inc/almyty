import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { DistributionTarget } from '../../entities/agent-app-distribution.entity';
import { AgentAppsService, CreateAppDto, UpdateAppDto } from './agent-apps.service';

/**
 * The agent factory API.
 *
 * Everything is addressed by name: `/apps/acme-support`, and its
 * distributions by the platform they ship to,
 * `/apps/acme-support/distributions/slack`. The slug is already unique
 * per organization and is what the product ships under, so it is what
 * an operator recognises and can type. An opaque id in a path is
 * unreadable and unshareable for no gain.
 *
 * Reading is open to members so a developer can see what exists.
 * Writing is admin-only, because it decides what the product is called,
 * who may use it, and what a downloadable artifact may do on the
 * machine it lands on.
 */
@Controller('apps')
@ApiTags('Agent factory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentAppsController {
  constructor(private readonly apps: AgentAppsService) {}

  private org(req: any): string {
    return req.user.currentOrganizationId;
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List apps' })
  async list(@Request() req: any) {
    return { success: true, data: await this.apps.list(this.org(req)) };
  }

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create an app' })
  async create(@Body() body: CreateAppDto, @Request() req: any) {
    return { success: true, data: await this.apps.create(this.org(req), body) };
  }

  @Get(':slug')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get one app with its distributions' })
  async findOne(@Param('slug') slug: string, @Request() req: any) {
    return { success: true, data: await this.apps.findOne(this.org(req), slug) };
  }

  /**
   * What is stopping this app from shipping.
   *
   * Separate from the record so a builder can show the unmet rules
   * continuously while someone is still editing, rather than letting
   * them discover the list when a publish is rejected.
   */
  @Get(':slug/check')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'What is stopping this app from shipping' })
  async check(@Param('slug') slug: string, @Request() req: any) {
    return { success: true, data: await this.apps.check(this.org(req), slug) };
  }

  @Patch(':slug')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update an app' })
  async update(@Param('slug') slug: string, @Body() body: UpdateAppDto, @Request() req: any) {
    return { success: true, data: await this.apps.update(this.org(req), slug, body) };
  }

  @Delete(':slug')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Delete an app' })
  async remove(@Param('slug') slug: string, @Request() req: any) {
    await this.apps.remove(this.org(req), slug);
    return { success: true };
  }

  @Post(':slug/distributions')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Ship this app somewhere' })
  async addDistribution(
    @Param('slug') slug: string,
    @Body()
    body: {
      target: DistributionTarget;
      configuration?: Record<string, any>;
      gatewayId?: string | null;
    },
    @Request() req: any,
  ) {
    return {
      success: true,
      data: await this.apps.addDistribution(
        this.org(req),
        slug,
        body.target,
        body.configuration ?? {},
        body.gatewayId ?? null,
      ),
    };
  }

  @Get(':slug/distributions/:target/check')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'What is stopping this distribution from shipping' })
  async checkDistribution(
    @Param('slug') slug: string,
    @Param('target') target: DistributionTarget,
    @Request() req: any,
  ) {
    return {
      success: true,
      data: await this.apps.checkDistribution(this.org(req), slug, target),
    };
  }

  /**
   * Record what a build produced.
   *
   * Called by the CLI after it builds on the customer's own machine,
   * because signing needs their certificates. Nothing here builds
   * anything; it stores the outcome so a binary already in circulation
   * can be identified later.
   */
  @Post(':slug/distributions/:target/build')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Record the outcome of a local build' })
  async recordBuild(
    @Param('slug') slug: string,
    @Param('target') target: DistributionTarget,
    @Body()
    body: {
      version?: string;
      platform?: string;
      checksum?: string;
      signed?: boolean;
      error?: string;
    },
    @Request() req: any,
  ) {
    return {
      success: true,
      data: await this.apps.recordBuild(this.org(req), slug, target, {
        ...body,
        builtBy: req.user?.email ?? req.user?.id,
      }),
    };
  }

  @Delete(':slug/distributions/:target')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Stop shipping to this target' })
  async removeDistribution(
    @Param('slug') slug: string,
    @Param('target') target: DistributionTarget,
    @Request() req: any,
  ) {
    await this.apps.removeDistribution(this.org(req), slug, target);
    return { success: true };
  }
}
