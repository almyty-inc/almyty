import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

import { ApprovalsService } from './approvals.service';

class DecisionDto {
  // Without an explicit class-validator decorator, ValidationPipe's
  // forbidNonWhitelisted=true strips this field and the body lands
  // empty — or worse, NestJS rejects it as "property decisionReason
  // should not exist". @IsOptional + @IsString opts it into the
  // whitelist and keeps the optionality semantics.
  @IsOptional()
  @IsString()
  decisionReason?: string;
}

/**
 * RBAC:
 *   GET  /approvals               — any org member; returns the
 *                                    approvals visible to them through
 *                                    AccessPolicyService.applyListFilter.
 *   GET  /approvals/:id           — same.
 *   POST /approvals/:id/approve   — must be team_admin (LEAD) for
 *                                    team-scoped requests, or org
 *                                    owner/admin. Enforced in service.
 *   POST /approvals/:id/reject    — same.
 */
@Controller('approvals')
@ApiTags('Approvals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List approval requests visible to the caller' })
  async list(@Request() req: any, @Query('status') _status?: string) {
    const data = await this.approvals.listPending({
      organizationId: req.user.currentOrganizationId,
      caller: { id: req.user.id },
    });
    return { success: true, data };
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  async get(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const data = await this.approvals.findOne(
      id,
      { id: req.user.id },
      req.user.currentOrganizationId,
    );
    return { success: true, data };
  }

  @Post(':id/approve')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Approve a pending approval (resumes the run)' })
  async approve(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecisionDto,
  ) {
    const data = await this.approvals.approve(
      id,
      { decidedBy: req.user.id, decisionReason: body?.decisionReason },
      { id: req.user.id },
    );
    return { success: true, data };
  }

  @Post(':id/reject')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Reject a pending approval (terminates the run)' })
  async reject(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecisionDto,
  ) {
    const data = await this.approvals.reject(
      id,
      { decidedBy: req.user.id, decisionReason: body?.decisionReason },
      { id: req.user.id },
    );
    return { success: true, data };
  }
}
