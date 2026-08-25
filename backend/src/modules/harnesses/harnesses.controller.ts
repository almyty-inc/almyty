import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { DistributionTarget } from '../../entities/harness-distribution.entity';
import {
  CreateHarnessDto,
  HarnessesService,
  UpdateHarnessDto,
} from './harnesses.service';

/**
 * The agent factory API.
 *
 * A harness is a product a customer ships, so writing one is an
 * admin-level act: it decides what the product is called, who may use
 * it, and what a downloadable artifact may do on the machine it lands
 * on. Reading is open to members so a developer can see what exists.
 */
@Controller('harnesses')
@ApiTags('Agent factory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class HarnessesController {
  constructor(private readonly harnesses: HarnessesService) {}

  private org(req: any): string {
    return req.user.currentOrganizationId;
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List agent products' })
  async list(@Request() req: any) {
    return { success: true, data: await this.harnesses.list(this.org(req)) };
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get one product with its distributions' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return { success: true, data: await this.harnesses.findOne(this.org(req), id) };
  }

  /**
   * Whether this product may ship, and what is stopping it.
   *
   * Separate from the record itself so the builder can show the unmet
   * rules continuously while someone is still editing, rather than only
   * discovering them when a publish is rejected.
   */
  @Get(':id/check')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'What is stopping this product from shipping' })
  async check(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return { success: true, data: await this.harnesses.check(this.org(req), id) };
  }

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create an agent product' })
  async create(@Body() body: CreateHarnessDto, @Request() req: any) {
    return { success: true, data: await this.harnesses.create(this.org(req), body) };
  }

  @Patch(':id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update an agent product' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateHarnessDto,
    @Request() req: any,
  ) {
    return { success: true, data: await this.harnesses.update(this.org(req), id, body) };
  }

  @Delete(':id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Delete an agent product' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    await this.harnesses.remove(this.org(req), id);
    return { success: true };
  }

  @Post(':id/distributions')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Ship this product somewhere' })
  async addDistribution(
    @Param('id', ParseUUIDPipe) id: string,
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
      data: await this.harnesses.addDistribution(
        this.org(req),
        id,
        body.target,
        body.configuration ?? {},
        body.gatewayId ?? null,
      ),
    };
  }

  @Get('distributions/:distributionId/check')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'What is stopping this distribution from building' })
  async checkDistribution(
    @Param('distributionId', ParseUUIDPipe) distributionId: string,
    @Request() req: any,
  ) {
    return {
      success: true,
      data: await this.harnesses.checkDistribution(this.org(req), distributionId),
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
  @Post('distributions/:distributionId/build')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Record the outcome of a local build' })
  async recordBuild(
    @Param('distributionId', ParseUUIDPipe) distributionId: string,
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
      data: await this.harnesses.recordBuild(this.org(req), distributionId, {
        ...body,
        builtBy: req.user?.email ?? req.user?.id,
      }),
    };
  }

  @Delete('distributions/:distributionId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Stop shipping to this target' })
  async removeDistribution(
    @Param('distributionId', ParseUUIDPipe) distributionId: string,
    @Request() req: any,
  ) {
    await this.harnesses.removeDistribution(this.org(req), distributionId);
    return { success: true };
  }
}
