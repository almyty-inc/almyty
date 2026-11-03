import { formatSpendCents, formatSpendShare } from '../budget-format';
import { BudgetExceededException } from '../budget-exceeded.exception';

/** Amounts and shares in budget alerts keep enough precision to mean something on a tiny budget. */
describe('budget alert formatting', () => {
  it('keeps fractions of a cent under a dollar, and two decimals from a dollar up', () => {
    expect(formatSpendCents(0)).toBe('$0.00');
    expect(formatSpendCents(1)).toBe('$0.01');
    expect(formatSpendCents(0.42)).toBe('$0.0042');
    expect(formatSpendCents(0.8)).toBe('$0.008');
    expect(formatSpendCents(50)).toBe('$0.50');
    expect(formatSpendCents(1250)).toBe('$12.50');
    expect(formatSpendCents(123456.78)).toBe('$1234.57');
  });

  it('never reads a share above nothing as 0%, nor one below the limit as 100%', () => {
    expect(formatSpendShare(0, 1)).toBe('0');
    expect(formatSpendShare(0.004, 1)).toBe('<1');
    expect(formatSpendShare(0.82, 1)).toBe('82');
    expect(formatSpendShare(999.6, 1000)).toBe('99');
    expect(formatSpendShare(1000, 1000)).toBe('100');
    expect(formatSpendShare(1500, 1000)).toBe('150');
    expect(formatSpendShare(5, 0)).toBe('0');
  });

  it('the over-budget refusal says the amounts the same way', () => {
    const err = new BudgetExceededException({ budgetId: 'b', organizationId: 'o', agentId: null, spentCents: 1.2, limitCents: 1, periodType: 'month' });
    expect((err.getResponse() as any).message).toContain('$0.012 of $0.01 used this month');
  });
});
