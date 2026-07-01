import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Request,
  UseGuards, ParseUUIDPipe, HttpStatus, HttpException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { BudgetsService, CreateBudgetDto, UpdateBudgetDto } from './budgets.service';
import { SpendService } from './spend.service';
import { startOfPeriod } from './spend-period.util';

/**
 * Spend-budget CRUD + spend visibility. Reads are member+, mutations
 * are admin/owner (same RBAC shape as the LLM-providers controller).
 */
@Controller('budgets')
@ApiTags('Cost Governance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class BudgetsController {
  constructor(
    private readonly budgets: BudgetsService,
    private readonly spend: SpendService,
  ) {}

  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        {
          success: false,
          message:
            'Organization context required. Multi-org users must send the X-Organization-Id header.',
          error: 'NO_ORGANIZATION',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  // ── Spend visibility (T2.1) ──────────────────────────────────────

  @Get('spend')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Aggregate spend over time + breakdown by agent' })
  async getSpend(
    @Query('period') period: string | undefined,
    @Query('granularity') granularity: string | undefined,
    @Request() req: any,
  ) {
    const organizationId = this.orgId(req);
    // `period` selects the rolling window start; day → today, month →
    // start of month. Defaults to month (the common budgeting cadence).
    const periodType = period === 'day' ? 'day' : 'month';
    const from = startOfPeriod(periodType, new Date());
    const data = await this.spend.getSummary(organizationId, {
      from,
      granularity: granularity ?? 'day',
    });
    return { success: true, data: { period: periodType, from, ...data } };
  }

  @Get('alerts')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List recent spend-budget breach alerts' })
  async listAlerts(@Query('limit') limit: string | undefined, @Request() req: any) {
    const organizationId = this.orgId(req);
    const data = await this.budgets.listAlerts(organizationId, limit ? parseInt(limit, 10) : 100);
    return { success: true, data };
  }

  // ── CRUD (T2.4) ──────────────────────────────────────────────────

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List spend budgets' })
  async list(@Request() req: any) {
    const data = await this.budgets.list(this.orgId(req));
    return { success: true, data };
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  @ApiParam({ name: 'id', description: 'Budget ID' })
  @ApiOperation({ summary: 'Get a spend budget' })
  async get(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const data = await this.budgets.get(id, this.orgId(req));
    return { success: true, data };
  }

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a spend budget' })
  async create(@Body() body: CreateBudgetDto, @Request() req: any) {
    const data = await this.budgets.create(this.orgId(req), body);
    return { success: true, data };
  }

  @Patch(':id')
  @Roles('admin', 'owner')
  @ApiParam({ name: 'id', description: 'Budget ID' })
  @ApiOperation({ summary: 'Update a spend budget' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBudgetDto,
    @Request() req: any,
  ) {
    const data = await this.budgets.update(id, this.orgId(req), body);
    return { success: true, data };
  }

  @Delete(':id')
  @Roles('admin', 'owner')
  @ApiParam({ name: 'id', description: 'Budget ID' })
  @ApiOperation({ summary: 'Delete a spend budget' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    await this.budgets.remove(id, this.orgId(req));
    return { success: true };
  }
}
