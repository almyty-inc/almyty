import {
  Controller, Post, Body, Param, Request,
  UseGuards, ParseUUIDPipe, HttpStatus, HttpException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AgentRuntimeService } from './agent-runtime.service';
import { PromotedSkillsService } from '../promoted-skills/promoted-skills.service';
import { userPrincipal } from '../../common/authorization/execution-access.service';

/**
 * Replay a promoted skill by re-running its source agent. Lives in the agents
 * module (which already owns AgentRuntimeService) so the promoted-skills module
 * stays free of an agent-runtime import — that direction creates a circular
 * dependency. Mounted at /promoted-skills/:id/replay alongside the CRUD routes.
 */
@Controller('promoted-skills')
@ApiTags('Promoted Skills')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class PromotedSkillReplayController {
  constructor(
    private readonly runtime: AgentRuntimeService,
    private readonly skills: PromotedSkillsService,
  ) {}

  @Post(':id/replay')
  @Roles('member', 'admin', 'owner')
  @ApiParam({ name: 'id', description: 'Promoted skill ID' })
  @ApiOperation({ summary: 'Replay a promoted skill (re-run its source agent)' })
  async replay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { input?: any },
    @Request() req: any,
  ) {
    const organizationId = req.user.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const userId = req.user.sub || req.user.id;

    // Another member's private-derived skill answers as not found.
    const skill = await this.skills.get(id, organizationId, userId);
    if (!skill.agentId) {
      throw new BadRequestException('The source agent no longer exists; cannot replay');
    }
    const input = body?.input ?? skill.inputExample ?? skill.description ?? '';
    // Replayed as the caller: a skill promoted from a team agent replays
    // only for that team, like running the agent directly.
    const run = await this.runtime.startRun(skill.agentId, organizationId, userId, input, {
      principal: userPrincipal(userId, 'replay'),
    });
    return { runId: run.id };
  }
}
