import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EnvironmentsService } from './environments.service';
import { HostedRunnersService } from './hosted-runners.service';
import { EnvironmentInsightsService } from './environment-insights.service';
import { CreateEnvironmentDto, UpdateEnvironmentDto } from './dto/environment.dto';

const VALIDATE = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

/**
 * Hosted environments (docs/hosted-runners.md). Reads go through the
 * access policy; writes need member or above, and sharing an environment
 * (team or org visibility) needs the hosted_shared_environments
 * entitlement. Creating and changing one needs HOSTED_RUNNERS_ENABLED.
 */
@Controller('environments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EnvironmentsController {
  constructor(
    private readonly environments: EnvironmentsService,
    private readonly hosted: HostedRunnersService,
    private readonly insights: EnvironmentInsightsService,
  ) {}

  private context(req: any): { userId: string; organizationId: string } {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    return { userId: req.user.id, organizationId };
  }

  @Get()
  @Roles('viewer', 'member', 'admin', 'owner')
  async list(@Request() req: any) {
    const { userId, organizationId } = this.context(req);
    return {
      success: true,
      data: await this.environments.list(userId, organizationId),
      enabled: this.hosted.enabled(),
      // The form's choices, from the install's settings and the plan.
      options: await this.insights.options(organizationId),
    };
  }

  /** What an environment form may offer: images, sizes, idle-timeout bounds and default, how long files are kept. */
  @Get('options')
  @Roles('viewer', 'member', 'admin', 'owner')
  async options(@Request() req: any) {
    const { organizationId } = this.context(req);
    return { success: true, data: await this.insights.options(organizationId) };
  }

  /** Runner minutes this month (or ?from=&to=), per environment you can see, and for the organization (owners and admins). */
  @Get('usage')
  @Roles('viewer', 'member', 'admin', 'owner')
  async usage(@Request() req: any, @Query('from') from?: string, @Query('to') to?: string) {
    const { userId, organizationId } = this.context(req);
    const period = this.insights.period(from, to);
    return { success: true, data: await this.insights.usage(userId, organizationId, period.from, period.to) };
  }

  @Post()
  @Roles('member', 'admin', 'owner')
  @UsePipes(VALIDATE)
  async create(@Request() req: any, @Body() body: CreateEnvironmentDto) {
    const { userId, organizationId } = this.context(req);
    return { success: true, data: await this.environments.create(body, userId, organizationId) };
  }

  @Get(':id')
  @Roles('viewer', 'member', 'admin', 'owner')
  async get(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const { userId, organizationId } = this.context(req);
    return { success: true, data: await this.environments.get(id, userId, organizationId) };
  }

  @Patch(':id')
  @Roles('member', 'admin', 'owner')
  @UsePipes(VALIDATE)
  async update(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateEnvironmentDto) {
    const { userId, organizationId } = this.context(req);
    return { success: true, data: await this.environments.update(id, body, userId, organizationId) };
  }

  @Delete(':id')
  @Roles('member', 'admin', 'owner')
  async remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const { userId, organizationId } = this.context(req);
    await this.environments.remove(id, userId, organizationId);
    return { success: true };
  }

  /** Runs of agents whose machine is this environment, newest first: yours, or all of them for an owner or admin. */
  @Get(':id/runs')
  @Roles('viewer', 'member', 'admin', 'owner')
  async runs(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) {
    const { userId, organizationId } = this.context(req);
    return { success: true, data: await this.insights.runs(id, userId, organizationId, limit ? Number(limit) : undefined) };
  }

  /** The environment's persistent workspaces: the caller's own, or all of them for an org admin. */
  @Get(':id/workspaces')
  @Roles('viewer', 'member', 'admin', 'owner')
  async workspaces(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const { userId, organizationId } = this.context(req);
    return { success: true, data: await this.hosted.listWorkspaces(id, userId, organizationId) };
  }

  /** Park a workspace now: its machine scales to zero, its files stay. */
  @Post(':id/workspaces/:workspaceId/suspend')
  @Roles('member', 'admin', 'owner')
  async suspend(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    const { userId, organizationId } = this.context(req);
    await this.hosted.assertReadableEnvironment(id, userId, organizationId);
    const machine = await this.hosted.suspend(workspaceId, userId, organizationId);
    return { success: true, data: { id: machine.id, state: machine.state, desired: machine.desired } };
  }

  /** Let a workspace go: released, and its files deleted with its volume. */
  @Post(':id/workspaces/:workspaceId/release')
  @Roles('member', 'admin', 'owner')
  async release(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    const { userId, organizationId } = this.context(req);
    await this.hosted.assertReadableEnvironment(id, userId, organizationId);
    return { success: true, data: await this.hosted.release(workspaceId, userId, organizationId) };
  }
}
