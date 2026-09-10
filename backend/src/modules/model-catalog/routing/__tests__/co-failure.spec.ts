import {
  AttemptRecord,
  MIN_COMPARABLE_REQUESTS,
  computeCoFailure,
  describeHeadroom,
  isReportable,
} from '../co-failure';

/**
 * Gate 7, third clause: beta computes on real run history.
 *
 * The number this produces is the ceiling on any routing gain. Getting it
 * wrong in the optimistic direction would justify work that cannot pay
 * off, so the tests below are mostly about what it refuses to count.
 */
const attempt = (taskClass: string, requestId: string, modelId: string, succeeded: boolean): AttemptRecord => ({
  taskClass,
  requestId,
  modelId,
  succeeded,
});

describe('co-failure is the ceiling on what routing can win', () => {
  it('counts a request every model failed as unrecoverable', () => {
    const [stats] = computeCoFailure([
      attempt('patch', 'r1', 'a', false),
      attempt('patch', 'r1', 'b', false),
    ]);
    expect(stats).toMatchObject({ comparableRequests: 1, coFailures: 1, coFailureRate: 1, routingHeadroom: 0 });
  });

  it('counts a request where one succeeded and one failed as headroom', () => {
    const [stats] = computeCoFailure([
      attempt('patch', 'r1', 'a', false),
      attempt('patch', 'r1', 'b', true),
    ]);
    expect(stats).toMatchObject({ routingHeadroom: 1, routingHeadroomRate: 1, coFailures: 0 });
  });

  it('counts a request every model answered as no headroom either', () => {
    // Routing cannot improve what already works. It belongs in neither
    // bucket, and conflating it with headroom would overstate the prize.
    const [stats] = computeCoFailure([
      attempt('patch', 'r1', 'a', true),
      attempt('patch', 'r1', 'b', true),
    ]);
    expect(stats).toMatchObject({ allSucceeded: 1, routingHeadroom: 0, coFailures: 0 });
  });

  it('ignores a request only one model ever saw', () => {
    // The exclusion that makes the number trustworthy: one attempt says
    // nothing about whether another model would have done better, and
    // counting it would pad the denominator with unanswerable cases.
    const stats = computeCoFailure([
      attempt('patch', 'r1', 'a', false),
      attempt('patch', 'r2', 'a', false),
      attempt('patch', 'r3', 'a', true),
    ]);
    expect(stats[0].comparableRequests).toBe(0);
    expect(stats[0].coFailureRate).toBe(0);
  });

  it('treats a model that eventually succeeded on a request as capable', () => {
    const [stats] = computeCoFailure([
      attempt('patch', 'r1', 'a', false),
      attempt('patch', 'r1', 'a', true),
      attempt('patch', 'r1', 'b', false),
    ]);
    // 'a' could answer it, so this is headroom rather than a co-failure.
    expect(stats).toMatchObject({ routingHeadroom: 1, coFailures: 0 });
  });

  it('keeps task classes apart, because headroom only means anything within one', () => {
    const stats = computeCoFailure([
      attempt('patch', 'r1', 'a', false),
      attempt('patch', 'r1', 'b', false),
      attempt('summarise', 'r2', 'a', false),
      attempt('summarise', 'r2', 'b', true),
    ]);
    expect(stats).toHaveLength(2);
    expect(stats.find((s) => s.taskClass === 'patch')!.coFailureRate).toBe(1);
    expect(stats.find((s) => s.taskClass === 'summarise')!.routingHeadroomRate).toBe(1);
  });

  it('orders by headroom, so the class worth working on is first', () => {
    const attempts: AttemptRecord[] = [];
    for (let i = 0; i < 10; i++) {
      attempts.push(attempt('low', `l${i}`, 'a', true), attempt('low', `l${i}`, 'b', true));
      attempts.push(attempt('high', `h${i}`, 'a', true), attempt('high', `h${i}`, 'b', false));
    }
    expect(computeCoFailure(attempts)[0].taskClass).toBe('high');
  });

  it('computes the rates over a realistic mix', () => {
    const attempts: AttemptRecord[] = [];
    // 5 co-failures, 3 headroom, 2 all-succeeded: 10 comparable requests.
    for (let i = 0; i < 5; i++) attempts.push(attempt('t', `co${i}`, 'a', false), attempt('t', `co${i}`, 'b', false));
    for (let i = 0; i < 3; i++) attempts.push(attempt('t', `hr${i}`, 'a', false), attempt('t', `hr${i}`, 'b', true));
    for (let i = 0; i < 2; i++) attempts.push(attempt('t', `ok${i}`, 'a', true), attempt('t', `ok${i}`, 'b', true));

    const [stats] = computeCoFailure(attempts);
    expect(stats.comparableRequests).toBe(10);
    expect(stats.coFailureRate).toBeCloseTo(0.5);
    expect(stats.routingHeadroomRate).toBeCloseTo(0.3);
    expect(stats.allSucceeded).toBe(2);
  });

  it('says nothing at all on empty history', () => {
    expect(computeCoFailure([])).toEqual([]);
  });
});

describe('it refuses to report a number it cannot stand behind', () => {
  const small = computeCoFailure([attempt('t', 'r1', 'a', false), attempt('t', 'r1', 'b', true)])[0];

  it('marks a thin sample unreportable rather than presenting noise', () => {
    expect(isReportable(small)).toBe(false);
    expect(describeHeadroom(small)).toContain('not enough comparable requests');
    expect(describeHeadroom(small)).toContain(String(MIN_COMPARABLE_REQUESTS));
  });

  it('reports once there is enough history, quoting the sample size', () => {
    const attempts: AttemptRecord[] = [];
    for (let i = 0; i < MIN_COMPARABLE_REQUESTS; i++) {
      attempts.push(attempt('t', `r${i}`, 'a', i % 2 === 0), attempt('t', `r${i}`, 'b', false));
    }
    const stats = computeCoFailure(attempts)[0];
    expect(isReportable(stats)).toBe(true);
    const line = describeHeadroom(stats);
    expect(line).toContain('routing headroom');
    expect(line).toContain('no policy recovers those');
    expect(line).toContain(`${MIN_COMPARABLE_REQUESTS} comparable requests`);
  });
});
