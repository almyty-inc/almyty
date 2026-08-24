import {
  DEFAULT_RUN_LIMITS,
  HARD_CEILING_ENV_KEYS,
  RUN_LIMIT_REASONS,
  agentRunLimits,
  checkRunLimits,
  describeLimitTrip,
  hardCeiling,
  organizationRunLimits,
  resolveRunLimits,
  runRequestedLimits,
} from '../run-limits';
import { Agent } from '../../../entities/agent.entity';
import { AgentRun } from '../../../entities/agent-run.entity';
import { Organization } from '../../../entities/organization.entity';

const org = (agentDefaults: any) => ({ agentDefaults }) as unknown as Organization;
const agent = (runLimits: any) => ({ agentConfig: { runLimits } }) as unknown as Agent;

describe('hardCeiling', () => {
  it('falls back when the environment says nothing', () => {
    const ceiling = hardCeiling({});
    expect(ceiling.maxSteps).toBe(100);
    expect(ceiling.maxCostCents).toBe(500);
    expect(ceiling.maxRecursionDepth).toBe(5);
  });

  it('reads every ceiling from its env key', () => {
    const ceiling = hardCeiling({
      [HARD_CEILING_ENV_KEYS.maxSteps]: '7',
      [HARD_CEILING_ENV_KEYS.maxTokens]: '1000',
      [HARD_CEILING_ENV_KEYS.maxCostCents]: '25',
      [HARD_CEILING_ENV_KEYS.maxDurationMs]: '60000',
      [HARD_CEILING_ENV_KEYS.maxToolCalls]: '3',
      [HARD_CEILING_ENV_KEYS.maxRecursionDepth]: '1',
    });
    expect(ceiling).toEqual({
      maxSteps: 7,
      maxTokens: 1000,
      maxCostCents: 25,
      maxDurationMs: 60000,
      maxToolCalls: 3,
      maxRecursionDepth: 1,
    });
  });

  it('ignores junk and non-positive values rather than trusting them', () => {
    const ceiling = hardCeiling({
      [HARD_CEILING_ENV_KEYS.maxSteps]: 'banana',
      [HARD_CEILING_ENV_KEYS.maxCostCents]: '0',
      [HARD_CEILING_ENV_KEYS.maxTokens]: '-5',
    });
    expect(ceiling.maxSteps).toBe(100);
    expect(ceiling.maxCostCents).toBe(500);
    expect(ceiling.maxTokens).toBe(2_000_000);
  });
});

describe('per-scope readers', () => {
  it('converts the organization cost default from currency units to cents', () => {
    expect(organizationRunLimits(org({ maxCostPerRun: 2.5, maxStepsPerRun: 30 }))).toEqual({
      maxSteps: 30,
      maxCostCents: 250,
    });
  });

  it('returns nothing for an organization with no defaults', () => {
    expect(organizationRunLimits(org(undefined))).toEqual({});
    expect(organizationRunLimits(null)).toEqual({});
  });

  it('reads the agent block from agentConfig.runLimits', () => {
    expect(agentRunLimits(agent({ maxSteps: 12 }))).toEqual({ maxSteps: 12 });
    expect(agentRunLimits(null)).toEqual({});
  });

  it('folds the run maxSteps column in with the run limits json', () => {
    const requested = runRequestedLimits({
      maxSteps: 40,
      limits: { maxCostCents: 60 },
    } as Partial<AgentRun>);
    expect(requested).toEqual({ maxSteps: 40, maxCostCents: 60 });
  });

  it('lets the limits json win over the column when both are set', () => {
    const requested = runRequestedLimits({
      maxSteps: 40,
      limits: { maxSteps: 5 },
    } as Partial<AgentRun>);
    expect(requested.maxSteps).toBe(5);
  });
});

describe('resolveRunLimits', () => {
  const env = {};

  it('uses the defaults when nothing is configured anywhere', () => {
    expect(resolveRunLimits({ env })).toEqual(DEFAULT_RUN_LIMITS);
  });

  it('takes the smallest value across scopes', () => {
    const resolved = resolveRunLimits({
      organization: org({ maxStepsPerRun: 40 }),
      agent: agent({ maxSteps: 20 }),
      env,
    });
    expect(resolved.maxSteps).toBe(20);
  });

  it('refuses to let an agent raise its own ceiling above organization policy', () => {
    const resolved = resolveRunLimits({
      organization: org({ maxStepsPerRun: 10 }),
      agent: agent({ maxSteps: 999 }),
      env,
    });
    expect(resolved.maxSteps).toBe(10);
  });

  it('refuses to let an organization raise its ceiling above the operator env cap', () => {
    const resolved = resolveRunLimits({
      organization: org({ maxStepsPerRun: 10_000, maxCostPerRun: 10_000 }),
      agent: agent({ maxSteps: 10_000 }),
      env: {},
    });
    expect(resolved.maxSteps).toBe(100);
    expect(resolved.maxCostCents).toBe(500);
  });

  it('honours a lowered operator env cap over every in-product scope', () => {
    const resolved = resolveRunLimits({
      organization: org({ maxStepsPerRun: 50 }),
      agent: agent({ maxSteps: 50 }),
      run: { maxSteps: 50 } as Partial<AgentRun>,
      env: { [HARD_CEILING_ENV_KEYS.maxSteps]: '4' },
    });
    expect(resolved.maxSteps).toBe(4);
  });

  it('lets a per-call override tighten but not loosen', () => {
    expect(
      resolveRunLimits({ agent: agent({ maxSteps: 20 }), requested: { maxSteps: 5 }, env }).maxSteps,
    ).toBe(5);
    expect(
      resolveRunLimits({ agent: agent({ maxSteps: 20 }), requested: { maxSteps: 90 }, env }).maxSteps,
    ).toBe(20);
  });

  describe('enum limits resolve most-restrictive-wins', () => {
    it('keeps fail over summarise over drop_oldest', () => {
      expect(
        resolveRunLimits({
          organization: org({}),
          agent: agent({ truncationPolicy: 'drop_oldest' }),
          requested: { truncationPolicy: 'fail' },
          env,
        }).truncationPolicy,
      ).toBe('fail');
    });

    it('does not let the agent loosen a suppressed tool-error feedback policy', () => {
      const resolved = resolveRunLimits({
        agent: agent({ toolErrorFeedback: 'full' }),
        requested: { toolErrorFeedback: 'suppressed' },
        env,
      });
      expect(resolved.toolErrorFeedback).toBe('suppressed');
    });

    it('ignores an unrecognised enum value instead of accepting it', () => {
      const resolved = resolveRunLimits({
        agent: agent({ truncationPolicy: 'yolo' }),
        env,
      });
      expect(resolved.truncationPolicy).toBe(DEFAULT_RUN_LIMITS.truncationPolicy);
    });
  });

  it('takes the fewest tool-error retries and allows zero', () => {
    expect(resolveRunLimits({ agent: agent({ toolErrorRetries: 0 }), env }).toolErrorRetries).toBe(0);
    expect(
      resolveRunLimits({
        agent: agent({ toolErrorRetries: 5 }),
        requested: { toolErrorRetries: 1 },
        env,
      }).toolErrorRetries,
    ).toBe(1);
  });
});

describe('checkRunLimits', () => {
  const limits = { ...DEFAULT_RUN_LIMITS, maxSteps: 5, maxCostCents: 100, maxTokens: 1000 };
  const createdAt = new Date('2026-01-01T00:00:00Z');
  const base = { currentStep: 0, totalCost: 0, totalTokens: 0, createdAt };
  const now = createdAt.getTime();

  it('returns null while the run is inside every ceiling', () => {
    expect(checkRunLimits(base as any, limits, now)).toBeNull();
  });

  it('trips on steps with a code and a human explanation', () => {
    const trip = checkRunLimits({ ...base, currentStep: 5 } as any, limits, now);
    expect(trip).toEqual({
      code: 'MAX_STEPS_EXCEEDED',
      message: RUN_LIMIT_REASONS.MAX_STEPS_EXCEEDED,
    });
  });

  it('compares dollars against cents correctly rather than 100x too high', () => {
    // totalCost is dollars, maxCostCents is cents: $1.00 hits a 100c cap.
    expect(checkRunLimits({ ...base, totalCost: 0.99 } as any, limits, now)).toBeNull();
    expect(checkRunLimits({ ...base, totalCost: 1.0 } as any, limits, now)?.code).toBe(
      'BUDGET_EXCEEDED',
    );
  });

  it('trips on the wall clock', () => {
    const trip = checkRunLimits(base as any, limits, now + limits.maxDurationMs + 1);
    expect(trip?.code).toBe('TIMEOUT');
  });

  it('trips on tokens, tool calls, and recursion depth', () => {
    expect(checkRunLimits({ ...base, totalTokens: 1000 } as any, limits, now)?.code).toBe(
      'TOKEN_LIMIT_EXCEEDED',
    );
    expect(
      checkRunLimits({ ...base, toolCallCount: limits.maxToolCalls } as any, limits, now)?.code,
    ).toBe('TOOL_CALL_LIMIT_EXCEEDED');
    expect(
      checkRunLimits({ ...base, recursionDepth: limits.maxRecursionDepth + 1 } as any, limits, now)
        ?.code,
    ).toBe('RECURSION_DEPTH_EXCEEDED');
  });

  it('treats a run at exactly the allowed recursion depth as fine', () => {
    expect(
      checkRunLimits({ ...base, recursionDepth: limits.maxRecursionDepth } as any, limits, now),
    ).toBeNull();
  });

  it('gives every reason code a non-empty explanation', () => {
    for (const code of Object.keys(RUN_LIMIT_REASONS) as Array<keyof typeof RUN_LIMIT_REASONS>) {
      expect(describeLimitTrip(code)).toEqual({ code, message: RUN_LIMIT_REASONS[code] });
      expect(RUN_LIMIT_REASONS[code].length).toBeGreaterThan(20);
    }
  });
});
