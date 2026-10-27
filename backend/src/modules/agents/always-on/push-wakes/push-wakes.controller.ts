import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { PrivateAgentGuard } from '../../../../common/authorization/private-resource.guard';
import { AgentsService } from '../../agents.service';
import { PushWakeInput, PushWakesService } from './push-wakes.service';

/**
 * An always-on agent's push wakes (push-wake.types.ts): list, add, change,
 * subscribe again and remove. The address services push to is
 * PushWakeReceiverController.
 */
@Controller('agents')
@ApiTags('Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PrivateAgentGuard)
export class PushWakesController {
  constructor(
    private readonly pushWakes: PushWakesService,
    private readonly agentsService: AgentsService,
  ) {}

  private organizationOf(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    return organizationId;
  }

  private fail(error: any, code: string): never {
    throw new HttpException(
      { success: false, message: error?.response?.message ?? error?.message ?? 'Something went wrong', error: code },
      error?.status || HttpStatus.BAD_REQUEST,
    );
  }

  @Get(':id/push-wakes')
  @ApiOperation({ summary: "The agent's push wakes, with their address, setup steps and health" })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async list(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      return { success: true, data: await this.pushWakes.list(id, organizationId) };
    } catch (error) {
      this.fail(error, 'PUSH_WAKES_READ_FAILED');
    }
  }

  @Get(':id/push-wakes/options')
  @ApiOperation({ summary: 'The push wake presets, and the connections (APIs) each can run on' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async options(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      return { success: true, data: await this.pushWakes.options(organizationId, req.user?.id ?? null) };
    } catch (error) {
      this.fail(error, 'PUSH_WAKES_OPTIONS_FAILED');
    }
  }

  @Get(':id/push-wakes/operations')
  @ApiOperation({ summary: "A connection's operations that have an active tool, for a custom push wake's steps" })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async operations(@Param('id', ParseUUIDPipe) id: string, @Query('apiId', ParseUUIDPipe) apiId: string, @Request() req: any) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      return { success: true, data: await this.pushWakes.operationsOf(apiId, organizationId) };
    } catch (error) {
      this.fail(error, 'PUSH_WAKES_OPERATIONS_FAILED');
    }
  }

  @Post(':id/push-wakes')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Add a push wake from a preset or a custom spec, and subscribe it' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'presetKey or spec; apiId, name, settings, debounceSeconds, secret (HMAC key or a service-chosen shared value)' })
  async create(@Param('id', ParseUUIDPipe) id: string, @Body() body: PushWakeInput, @Request() req: any) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      const view = await this.pushWakes.create(id, organizationId, body ?? {}, req.user?.id ?? null);
      return { success: true, data: view, message: view.health.status === 'failed' ? 'Saved; subscribing failed' : 'Saved' };
    } catch (error) {
      this.fail(error, 'PUSH_WAKE_CREATE_FAILED');
    }
  }

  @Patch(':id/push-wakes/:pushWakeId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Change a push wake: name, debounce window, settings (new settings subscribe again)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pushWakeId', ParseUUIDPipe) pushWakeId: string,
    @Body() body: Pick<PushWakeInput, 'name' | 'debounceSeconds' | 'settings'>,
    @Request() req: any,
  ) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      return { success: true, data: await this.pushWakes.update(pushWakeId, id, organizationId, body ?? {}) };
    } catch (error) {
      this.fail(error, 'PUSH_WAKE_UPDATE_FAILED');
    }
  }

  @Post(':id/push-wakes/:pushWakeId/subscribe')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Subscribe a push wake again now' })
  async resubscribe(@Param('id', ParseUUIDPipe) id: string, @Param('pushWakeId', ParseUUIDPipe) pushWakeId: string, @Request() req: any) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      return { success: true, data: await this.pushWakes.resubscribe(pushWakeId, id, organizationId) };
    } catch (error) {
      this.fail(error, 'PUSH_WAKE_SUBSCRIBE_FAILED');
    }
  }

  @Delete(':id/push-wakes/:pushWakeId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Remove a push wake: stops the subscription at the service and drops its secret' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Param('pushWakeId', ParseUUIDPipe) pushWakeId: string, @Request() req: any) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      return { success: true, data: await this.pushWakes.remove(pushWakeId, id, organizationId) };
    } catch (error) {
      this.fail(error, 'PUSH_WAKE_DELETE_FAILED');
    }
  }
}

/**
 * Where services push (no session: each push proves itself as its wake
 * source's spec says). 204 for a push that is taken or deliberately
 * ignored, 401 for one that does not verify, 404 for an address that is
 * not a push wake. Nothing in the answer says why.
 */
@Controller('push-wakes')
@ApiTags('Agents')
export class PushWakeReceiverController {
  constructor(private readonly pushWakes: PushWakesService) {}

  @Post(':subscriptionId')
  @HttpCode(204)
  @ApiExcludeEndpoint()
  async receive(@Param('subscriptionId') subscriptionId: string, @Req() req: any): Promise<void> {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : (v as string | undefined);
    const rawBody = req.rawBody ? Buffer.from(req.rawBody).toString('utf8') : JSON.stringify(req.body ?? {});
    const outcome = await this.pushWakes.receive(subscriptionId, { headers, rawBody });
    if (outcome === 'unknown') throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    if (outcome === 'rejected') throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
  }
}
