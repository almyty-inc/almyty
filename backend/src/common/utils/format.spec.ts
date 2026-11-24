import { formatCost, formatCostCents, formatDuration } from './format';

describe('formatCost', () => {
  it('shows two decimals from a cent up', () => {
    expect(formatCost(2.4665)).toBe('$2.47');
    expect(formatCost(0.25)).toBe('$0.25');
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(1234.5)).toBe('$1,234.50');
  });

  it('says "<$0.01" for a fraction of a cent, and "--" for nothing', () => {
    expect(formatCost(0.0042)).toBe('<$0.01');
    expect(formatCost(0.0049)).toBe('<$0.01');
    expect(formatCost(0)).toBe('--');
    expect(formatCost(null)).toBe('--');
    expect(formatCost(undefined)).toBe('--');
    expect(formatCost(Number.NaN)).toBe('--');
    expect(formatCost(0, { empty: '$0.00' })).toBe('$0.00');
  });

  it('keeps the sign of a negative amount', () => {
    expect(formatCost(-0.5)).toBe('-$0.50');
    expect(formatCost(-0.001)).toBe('-<$0.01');
  });

  it('reads cents the same way', () => {
    expect(formatCostCents(246.65)).toBe('$2.47');
    expect(formatCostCents(0.42)).toBe('<$0.01');
    expect(formatCostCents(0)).toBe('--');
  });
});

describe('formatDuration', () => {
  it('uses tenths under a second', () => {
    expect(formatDuration(400)).toBe('0.4s');
    expect(formatDuration(30)).toBe('<0.1s');
  });

  it('uses whole seconds under a minute', () => {
    expect(formatDuration(55_000)).toBe('55s');
    expect(formatDuration(970)).toBe('1s');
    expect(formatDuration(9_500)).toBe('10s');
  });

  it('uses minutes and seconds under an hour, never a decimal minute', () => {
    expect(formatDuration(78_000)).toBe('1m 18s');
    expect(formatDuration(76_600)).toBe('1m 17s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(59_600)).toBe('1m');
  });

  it('uses hours and minutes from an hour up', () => {
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
    expect(formatDuration(3_600_000)).toBe('1h');
  });

  it('says "--" for nothing', () => {
    expect(formatDuration(0)).toBe('--');
    expect(formatDuration(null)).toBe('--');
    expect(formatDuration(-5)).toBe('--');
  });
});
