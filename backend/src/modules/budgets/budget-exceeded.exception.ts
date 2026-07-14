import { ForbiddenException } from '@nestjs/common';

/**
 * Thrown when a `reject`-behavior spend budget's period-to-date total
 * has reached its limit, blocking a new run before it starts. A 403
 * with a stable `error` code so callers (and the frontend) can tell a
 * budget block apart from a generic permission failure.
 */
export class BudgetExceededException extends ForbiddenException {
  constructor(
    public readonly detail: {
      budgetId: string;
      organizationId: string;
      agentId: string | null;
      spentCents: number;
      limitCents: number;
      periodType: string;
    },
  ) {
    super({
      success: false,
      error: 'SPEND_BUDGET_EXCEEDED',
      message:
        `Spend budget exceeded: $${(detail.spentCents / 100).toFixed(2)} of ` +
        `$${(detail.limitCents / 100).toFixed(2)} used this ${detail.periodType}. ` +
        `New runs are blocked until the budget resets.`,
      detail,
    });
    this.name = 'BudgetExceededException';
  }
}
