import {
  Controller, Get, Post, Patch, Delete, Body, Param, Request,
  UseGuards, ParseUUIDPipe, HttpStatus, HttpException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiTags, ApiOperation, ApiParam, ApiBearerAuth } from '@nestjs/swagger';

import { Agent } from '../../entities/agent.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AgentConstraintsService } from './agent-constraints.service';

@Controller('agents/:agentId/constraints')
@ApiTags('Agent Constraints')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentConstraintsController {
  constructor(
    private readonly service: AgentConstraintsService,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
  ) {}

  private orgId(req: any): string {
    const organizationId = req.user.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  /**
   * The agent named in the path has to be one of this org's, otherwise the
   * route writes a row keyed to an agent the caller cannot see.
   */
  private async assertAgent(organizationId: string, agentId: string): Promise<void> {
    const found = await this.agents.count({ where: { id: agentId, organizationId } });
    if (!found) {
      throw new HttpException(
        { success: false, message: 'Agent not found', error: 'AGENT_NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiParam({ name: 'agentId', description: 'Agent ID' })
  @ApiOperation({ summary: 'List an agent constraints (failure memory)' })
  async list(@Param('agentId', ParseUUIDPipe) agentId: string, @Request() req: any) {
    return this.service.list(this.orgId(req), agentId);
  }

  @Post()
  @Roles('member', 'admin', 'owner')
  @ApiParam({ name: 'agentId', description: 'Agent ID' })
  @ApiOperation({ summary: 'Add a constraint to an agent' })
  async add(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: { rule: string },
    @Request() req: any,
  ) {
    if (!body?.rule?.trim()) {
      throw new HttpException('rule is required', HttpStatus.BAD_REQUEST);
    }
    const organizationId = this.orgId(req);
    await this.assertAgent(organizationId, agentId);
    const userId = req.user.sub || req.user.id;
    return this.service.add(organizationId, agentId, body.rule, userId);
  }

  @Patch(':id')
  @Roles('member', 'admin', 'owner')
  @ApiParam({ name: 'agentId', description: 'Agent ID' })
  @ApiParam({ name: 'id', description: 'Constraint ID' })
  @ApiOperation({ summary: 'Activate or deactivate a constraint' })
  async setActive(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { active: boolean },
    @Request() req: any,
  ) {
    return this.service.setActive(id, this.orgId(req), body.active, agentId);
  }

  @Delete(':id')
  @Roles('admin', 'owner')
  @ApiParam({ name: 'agentId', description: 'Agent ID' })
  @ApiParam({ name: 'id', description: 'Constraint ID' })
  @ApiOperation({ summary: 'Delete a constraint' })
  async remove(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
  ) {
    await this.service.remove(id, this.orgId(req), agentId);
    return { success: true };
  }
}
