import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SpendBudget } from '../../entities/spend-budget.entity';
import { SpendAlert } from '../../entities/spend-alert.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { User } from '../../entities/user.entity';

import { BudgetsService } from './budgets.service';
import { SpendService } from './spend.service';
import { BudgetsController } from './budgets.controller';

/**
 * Cost governance (P2). Owns spend aggregation, budget CRUD, and the
 * pre-run enforcement hook. Exports BudgetsService so the agents
 * runtime can call `enforceForRun` before starting an autonomous run.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SpendBudget, SpendAlert, AgentRun, UserOrganization, User]),
  ],
  providers: [BudgetsService, SpendService],
  controllers: [BudgetsController],
  exports: [BudgetsService, SpendService],
})
export class BudgetsModule {}
