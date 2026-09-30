import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AmountRuleInput, AmountRulesService } from './amount-rules.service';

/**
 * Amount rules, free for every organization: "ask before issue_refund
 * when amount is over 500". Organization owners and admins manage them.
 * The Business approval-policy endpoints (/approval-policies) manage the
 * rest of approval policies.
 */
@Controller('approval-rules')
@ApiTags('Approvals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'owner')
export class AmountRulesController {
  constructor(private readonly rules: AmountRulesService) {}

  @Get()
  @ApiOperation({ summary: "The organization's amount rules" })
  async list(@Request() req: any) {
    return { success: true, data: await this.rules.list(req.user.currentOrganizationId) };
  }

  @Get(':id')
  async get(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.rules.get(req.user.currentOrganizationId, id) };
  }

  @Post()
  @ApiOperation({ summary: 'Create an amount rule' })
  async create(@Request() req: any, @Body() body: AmountRuleInput) {
    return { success: true, data: await this.rules.create(req.user.currentOrganizationId, body ?? {}) };
  }

  @Patch(':id')
  async update(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: AmountRuleInput) {
    return { success: true, data: await this.rules.update(req.user.currentOrganizationId, id, body ?? {}) };
  }

  @Delete(':id')
  async remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.rules.remove(req.user.currentOrganizationId, id);
    return { success: true };
  }
}
