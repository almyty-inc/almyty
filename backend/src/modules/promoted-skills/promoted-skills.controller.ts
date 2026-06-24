import {
  Controller, Get, Post, Delete, Body, Param, Request, Res,
  UseGuards, ParseUUIDPipe, HttpStatus, HttpException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PromotedSkillsService, PromoteRunDto } from './promoted-skills.service';

@Controller('promoted-skills')
@ApiTags('Promoted Skills')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class PromotedSkillsController {
  constructor(private readonly service: PromotedSkillsService) {}

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

  @Post()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Promote a completed agent run into a reusable skill' })
  @ApiResponse({ status: 201, description: 'Skill created (or re-versioned)' })
  async promote(
    @Body() body: { runId: string } & PromoteRunDto,
    @Request() req: any,
  ) {
    const organizationId = this.orgId(req);
    if (!body?.runId) {
      throw new HttpException('runId is required', HttpStatus.BAD_REQUEST);
    }
    const userId = req.user.sub || req.user.id;
    return this.service.promoteFromRun(body.runId, organizationId, userId, body);
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List promoted skills' })
  async list(@Request() req: any) {
    return this.service.list(this.orgId(req));
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  @ApiParam({ name: 'id', description: 'Promoted skill ID' })
  @ApiOperation({ summary: 'Get a promoted skill' })
  async get(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.service.get(id, this.orgId(req));
  }

  @Get(':id/skill.md')
  @Roles('member', 'admin', 'owner')
  @ApiParam({ name: 'id', description: 'Promoted skill ID' })
  @ApiOperation({ summary: 'Get the raw SKILL.md for a promoted skill' })
  async raw(@Param('id', ParseUUIDPipe) id: string, @Request() req: any, @Res() res: Response) {
    const skill = await this.service.get(id, this.orgId(req));
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(skill.content);
  }

  @Delete(':id')
  @Roles('admin', 'owner')
  @ApiParam({ name: 'id', description: 'Promoted skill ID' })
  @ApiOperation({ summary: 'Delete a promoted skill' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    await this.service.remove(id, this.orgId(req));
    return { success: true };
  }
}
