import { GatewaysStatsHelper } from '../gateways-stats.helper';
import { ToolsStatsHelper } from '../../tools/tools-stats.helper';

/**
 * Both trend calculators used to be `for (bucket) { rows.filter(...) }` — a
 * nested scan that re-walked the whole (50,000-row capped) array once per
 * bucket, constructing a Date and calling toDateString() for every row every
 * time. A `day` timeframe is 30 buckets, so 1.5M Date constructions and 1.5M
 * toDateString() calls per page view, synchronous, on the event loop.
 *
 * These tests count the work rather than timing it: one pass over the rows
 * plus one lookup per bucket is O(rows + buckets), never O(rows x buckets).
 */
describe('trend calculators are one pass over the rows', () => {
  const gateways = new GatewaysStatsHelper(
    null as any, null as any, null as any, null as any, null as any,
  );
  const tools = new ToolsStatsHelper(null as any, null as any, null as any);

  /** Count Date construction and toDateString() while `fn` runs. */
  function countDateWork<T>(fn: () => T): { result: T; toDateStrings: number } {
    const original = Date.prototype.toDateString;
    let toDateStrings = 0;
    Date.prototype.toDateString = function (this: Date) {
      toDateStrings++;
      return original.call(this);
    };
    try {
      return { result: fn(), toDateStrings };
    } finally {
      Date.prototype.toDateString = original;
    }
  }

  const ROWS = 2_000;
  const DAY_BUCKETS = 30;

  it('calculateRequestTrend scans the rows once, not once per bucket', () => {
    const now = new Date();
    const metrics = Array.from({ length: ROWS }, () => ({
      type: 'request_count',
      value: 1,
      status: 'success',
      createdAt: now,
    })) as any[];

    const { result, toDateStrings } = countDateWork(() =>
      (gateways as any).calculateRequestTrend(metrics, 'day'),
    );

    expect(result).toHaveLength(DAY_BUCKETS);
    // One per row (the single pass) plus one per bucket (the lookup).
    expect(toDateStrings).toBeLessThanOrEqual(ROWS + DAY_BUCKETS * 2);
    // The nested scan would have been ROWS * DAY_BUCKETS = 60,000.
    expect(toDateStrings).toBeLessThan(ROWS * DAY_BUCKETS);
  });

  it('calculateExecutionTrend scans the rows once, not once per bucket', () => {
    const now = new Date();
    const executions = Array.from({ length: ROWS }, () => ({
      success: true,
      createdAt: now,
    })) as any[];

    const { result, toDateStrings } = countDateWork(() =>
      (tools as any).calculateExecutionTrend(executions, 'day'),
    );

    expect(result).toHaveLength(DAY_BUCKETS);
    expect(toDateStrings).toBeLessThanOrEqual(ROWS + DAY_BUCKETS * 2);
    expect(toDateStrings).toBeLessThan(ROWS * DAY_BUCKETS);
  });

  it('still totals each bucket the way the nested scan did', () => {
    const now = new Date();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const metrics = [
      { type: 'request_count', value: 5, status: 'success', createdAt: now },
      { type: 'request_count', value: 3, status: 'error', createdAt: now },
      { type: 'request_count', value: 2, status: 'success', createdAt: yesterday },
      // A different metric type must not be counted at all.
      { type: 'response_time', value: 99, status: 'success', createdAt: now },
    ] as any[];

    const trend = (gateways as any).calculateRequestTrend(metrics, 'day');
    const today = trend[trend.length - 1];
    const before = trend[trend.length - 2];

    expect(today).toMatchObject({ requests: 8, success: 5, failed: 3 });
    expect(before).toMatchObject({ requests: 2, success: 2, failed: 0 });

    const executions = [
      { success: true, createdAt: now },
      { success: false, createdAt: now },
      { success: true, createdAt: yesterday },
    ] as any[];
    const execTrend = (tools as any).calculateExecutionTrend(executions, 'day');
    expect(execTrend[execTrend.length - 1]).toMatchObject({
      executions: 2, success: 1, failed: 1,
    });
    expect(execTrend[execTrend.length - 2]).toMatchObject({
      executions: 1, success: 1, failed: 0,
    });
  });

  it('buckets hour, week and month the same way the filters did', () => {
    const now = new Date();
    const metrics = [
      { type: 'request_count', value: 4, status: 'success', createdAt: now },
    ] as any[];

    for (const [timeframe, length] of [['hour', 24], ['week', 12], ['month', 12]] as const) {
      const trend = (gateways as any).calculateRequestTrend(metrics, timeframe);
      expect(trend).toHaveLength(length);
      expect(trend[trend.length - 1].requests).toBe(4);
    }
  });
});
