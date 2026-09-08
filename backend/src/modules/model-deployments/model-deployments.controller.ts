import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Request, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdapterRegistry } from './adapters/adapter.registry';
import { ModelDeploymentsService } from './model-deployments.service';
import { CreateModelDeploymentBodyDto, ScaleModelDeploymentBodyDto } from './dto/model-deployments-controller.dto';

/**
 * Desired state only. Nothing here touches a provider; the reconcile
 * queue does, and every mutation is audited there.
 */
@ApiTags('Model deployments')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ModelDeploymentsController {
  constructor(
    private readonly deployments: ModelDeploymentsService,
    private readonly adapters: AdapterRegistry,
  ) {}

  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found for user', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    return organizationId;
  }

  /** Everything a form needs to render a deploy for any adapter, and nothing else. */
  @Get('model-adapters')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Registered deployment adapters with capabilities and config schema' })
  listAdapters() {
    return { success: true, data: this.adapters.describe() };
  }

  @Get('model-deployments')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List deployments' })
  async list(@Request() req: any) {
    const rows = await this.deployments.list(this.orgId(req));
    return { success: true, data: rows.map((d) => d.toPublicView()) };
  }

  @Get('model-deployments/:id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Deployment detail: desired vs actual, state, cost' })
  async get(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const d = await this.deployments.get(this.orgId(req), id);
    return { success: true, data: d.toPublicView() };
  }

  @Post('model-deployments')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a deployment (desired state); reconcile does the rest' })
  async create(@Request() req: any, @Body(ValidationPipe) body: CreateModelDeploymentBodyDto) {
    const d = await this.deployments.create(this.orgId(req), req.user?.id ?? null, body);
    return { success: true, data: d.toPublicView(), message: 'Deployment queued' };
  }

  @Post('model-deployments/:id/scale')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Set desired replicas (0 scales to zero)' })
  async scale(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body(ValidationPipe) body: ScaleModelDeploymentBodyDto) {
    const d = await this.deployments.scale(this.orgId(req), id, body.replicas, req.user?.id ?? null);
    return { success: true, data: d.toPublicView() };
  }

  @Post('model-deployments/:id/teardown')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Tear the endpoint down; weights stay in the registry' })
  async teardown(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const d = await this.deployments.teardown(this.orgId(req), id, req.user?.id ?? null);
    return { success: true, data: d.toPublicView() };
  }

  @Delete('model-deployments/:id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Same as teardown' })
  async remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const d = await this.deployments.teardown(this.orgId(req), id, req.user?.id ?? null);
    return { success: true, data: d.toPublicView() };
  }
}
