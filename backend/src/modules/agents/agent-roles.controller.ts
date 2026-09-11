import {
  Body, Controller, Delete, Get, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Request, UseGuards, ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsIn, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AgentRole } from '../../entities/agent-role.entity';
import { AgentRolesService } from './agent-roles.service';

class BindingDto {
  @IsIn(['pinned', 'resolved']) mode: 'pinned' | 'resolved';
  /** Required when mode is pinned. */
  @IsOptional() @IsString() modelId?: string;
  /** Required when mode is resolved. */
  @IsOptional() @IsObject() policy?: Record<string, unknown>;
}

class UpsertRoleBodyDto {
  @IsString() @MaxLength(64) key: string;
  @IsString() @MaxLength(128) displayName: string;
  @IsOptional() @IsObject() requirement?: Record<string, unknown>;
  @ValidateNested() @Type(() => BindingDto) binding: BindingDto;
}

/**
 * Roles on one agent.
 *
 * Kept under the agent rather than at the top level because a role key is
 * unique per agent and means nothing without it. See
 * docs/design/layers.md, L4.
 */
@ApiTags('Agent roles')
@ApiBearerAuth()
@Controller('agents/:agentId/roles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentRolesController {
  constructor(
    @InjectRepository(AgentRole) private readonly roles: Repository<AgentRole>,
    private readonly rolesService: AgentRolesService,
  ) {}

  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found for user', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    return organizationId;
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: "An agent's roles and what fills each" })
  async list(@Request() req: any, @Param('agentId', ParseUUIDPipe) agentId: string) {
    return { success: true, data: await this.rolesService.list(this.orgId(req), agentId) };
  }

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create or update a role by key' })
  async upsert(
    @Request() req: any,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body(new ValidationPipe({ transform: true })) body: UpsertRoleBodyDto,
  ) {
    const organizationId = this.orgId(req);
    // A binding has to say what fills the role. Accepting one that says
    // neither would store a role that fails at run time instead of here.
    if (body.binding.mode === 'pinned' && !body.binding.modelId) {
      throw new HttpException(
        { success: false, code: 'BINDING_INCOMPLETE', message: 'A pinned binding needs a modelId' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (body.binding.mode === 'resolved' && !body.binding.policy) {
      throw new HttpException(
        { success: false, code: 'BINDING_INCOMPLETE', message: 'A resolved binding needs a routing policy' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const existing = await this.roles.findOne({ where: { organizationId, agentId, key: body.key } });
    const row = this.roles.create({
      ...(existing ?? {}),
      organizationId,
      agentId,
      key: body.key,
      displayName: body.displayName,
      requirement: (body.requirement ?? {}) as AgentRole['requirement'],
      binding: body.binding as unknown as AgentRole['binding'],
    });
    return { success: true, data: await this.roles.save(row) };
  }

  @Delete(':key')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Remove a role' })
  async remove(@Request() req: any, @Param('agentId', ParseUUIDPipe) agentId: string, @Param('key') key: string) {
    await this.roles.delete({ organizationId: this.orgId(req), agentId, key });
    return { success: true };
  }

  @Post('resolve')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'What each role would resolve to right now' })
  async resolve(@Request() req: any, @Param('agentId', ParseUUIDPipe) agentId: string) {
    const resolved = await this.rolesService.resolveRoles(
      this.orgId(req),
      agentId,
      {},
      req.user?.id ? { id: req.user.id } : undefined,
    );
    return { success: true, data: resolved };
  }
}
