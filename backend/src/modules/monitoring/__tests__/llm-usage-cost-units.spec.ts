import { AnalyticsService } from '../analytics.service';

/**
 * `totalCostCents` has to carry cents.
 *
 * Conversation.totalCost is dollars — SpendService documents the same
 * for AgentRun.totalCost and multiplies by 100 to convert — and this
 * endpoint used to select that sum straight into a field named cents,
 * rounded to two decimals. The LLM analytics tab divides the field by
 * 100 before rendering, so the number a tenant saw was 100x smaller
 * than what they spent.
 */
describe('AnalyticsService.getLlmUsage — cost units', () => {
  const serviceFor = (rows: Record<string, any>[]) => {
    const conversationRepository: any = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      })),
    };
    return new AnalyticsService(
      {} as any,
      {} as any,
      {} as any,
      conversationRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  };

  const row = (over: Record<string, any> = {}) => ({
    providerId: 'prov-1',
    sessionCount: '2',
    totalMessages: '10',
    totalInputTokens: '100',
    totalOutputTokens: '200',
    totalCostDollars: '12.34',
    totalToolCalls: '3',
    ...over,
  });

  it('converts the dollar sum into whole cents', async () => {
    const [usage] = await serviceFor([row()]).getLlmUsage('org-1', '7d');

    expect(usage.totalCostCents).toBe(1234);
  });

  it('rounds sub-cent amounts instead of truncating to two decimal dollars', async () => {
    const [usage] = await serviceFor([row({ totalCostDollars: '0.004' })]).getLlmUsage(
      'org-1',
      '7d',
    );

    expect(usage.totalCostCents).toBe(0);

    const [cheap] = await serviceFor([row({ totalCostDollars: '0.006' })]).getLlmUsage(
      'org-1',
      '7d',
    );
    expect(cheap.totalCostCents).toBe(1);
  });

  it('reports zero for a provider with no recorded cost', async () => {
    // SUM() over no non-null rows is NULL, which parseFloat turns into NaN.
    const [usage] = await serviceFor([row({ totalCostDollars: null })]).getLlmUsage(
      'org-1',
      '7d',
    );

    expect(usage.totalCostCents).toBe(0);
  });
});
