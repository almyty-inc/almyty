import { codeModeProblems, decideCall, grantsLeftFor } from '../code-write-policy';
import { codeModeEnvLimits, codeModeLimits, scriptTimeoutMs } from '../code-mode.settings';

const TOOL = '3f1c2b6e-0d9a-4c4e-9b1a-2f6d8e7c5a10';
const OTHER = '9a1c2b6e-0d9a-4c4e-9b1a-2f6d8e7c5a10';

/**
 * The write policy (docs/design/code-mode.md, part D, decision 5): every
 * cell of class x policy x grant.
 */
describe('code mode write policy', () => {
  const none = () => new Map<string, number>();

  it('runs reads whatever the policy says', () => {
    expect(decideCall('read', TOOL, { writes: { write: 'deny', destructive: 'deny', tools: { [TOOL]: 'deny' } } }, none())).toEqual({ action: 'run' });
  });

  it('allows writes and stages deletions by default', () => {
    expect(decideCall('write', TOOL, undefined, none())).toEqual({ action: 'run' });
    expect(decideCall('destructive', TOOL, undefined, none())).toEqual({ action: 'stage' });
    // No class (an unclassified row) is a write: decision 4.
    expect(decideCall(undefined, TOOL, undefined, none())).toEqual({ action: 'run' });
  });

  it.each([
    ['write', 'allow', 'run'],
    ['write', 'stage', 'stage'],
    ['write', 'deny', 'deny'],
    ['destructive', 'allow', 'run'],
    ['destructive', 'stage', 'stage'],
    ['destructive', 'deny', 'deny'],
  ] as const)('a %s under %s: %s', (cls, action, expected) => {
    const config = { writes: { [cls]: action } };
    expect(decideCall(cls, TOOL, config, none()).action).toBe(expected);
  });

  it('lets a per-tool exception win over its class', () => {
    const config = { writes: { write: 'stage' as const, destructive: 'deny' as const, tools: { [TOOL]: 'allow' as const } } };
    expect(decideCall('write', TOOL, config, none()).action).toBe('run');
    expect(decideCall('destructive', TOOL, config, none()).action).toBe('run');
    expect(decideCall('write', OTHER, config, none()).action).toBe('stage');
  });

  it('lets a grant through staging until its count is used, never through a deny', () => {
    const left = grantsLeftFor({ grants: [{ toolId: TOOL, max: 2 }] }, { [TOOL]: 1 });
    expect(left.get(TOOL)).toBe(1);
    expect(decideCall('destructive', TOOL, undefined, left)).toEqual({ action: 'run', viaGrant: true });
    expect(decideCall('destructive', TOOL, undefined, left)).toEqual({ action: 'stage' });
    const again = grantsLeftFor({ grants: [{ toolId: TOOL, max: 5 }] }, {});
    expect(decideCall('write', TOOL, { writes: { write: 'deny' } }, again)).toEqual({ action: 'deny' });
    expect(again.get(TOOL)).toBe(5);
  });

  it('names what is wrong with the settings', () => {
    expect(codeModeProblems(undefined)).toEqual([]);
    expect(codeModeProblems({ writes: { write: 'stage', tools: { [TOOL]: 'deny' } }, grants: [{ toolId: TOOL, max: 20 }] })).toEqual([]);
    expect(codeModeProblems({ writes: { write: 'maybe' } })).toHaveLength(1);
    expect(codeModeProblems({ writes: { tools: { 'not-an-id': 'allow' } } })).toHaveLength(1);
    expect(codeModeProblems({ grants: [{ toolId: TOOL, max: 0 }] })).toHaveLength(1);
    expect(codeModeProblems({ extractor: { providerId: 'x' } })).toHaveLength(1);
    expect(codeModeProblems('yes')).toHaveLength(1);
  });
});

describe('code mode limits', () => {
  it('defaults to the design numbers', () => {
    expect(codeModeEnvLimits({})).toEqual({
      maxCalls: 100,
      maxInFlight: 4,
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 120_000,
      memoryMb: 128,
      logCapChars: 16_384,
      resultCapChars: 16_384,
      maxCodeChars: 50_000,
      cpuBudgetMs: 10_000,
    });
  });

  it('takes every number from the environment, and lets an organization only lower them', () => {
    const env = { CODE_MODE_MAX_CALLS: '500', CODE_MODE_MAX_TIMEOUT_MS: '60000', CODE_MODE_TIMEOUT_MS: '90000' };
    expect(codeModeEnvLimits(env)).toMatchObject({ maxCalls: 500, maxTimeoutMs: 60_000, defaultTimeoutMs: 60_000 });
    expect(codeModeLimits({ maxCalls: 20, memoryMb: 4096, maxInFlight: 'x' }, env)).toMatchObject({ maxCalls: 20, memoryMb: 128, maxInFlight: 4 });
  });

  it('gives a script the time it asks for, within the maximum', () => {
    const limits = codeModeEnvLimits({});
    expect(scriptTimeoutMs(undefined, limits)).toBe(30_000);
    expect(scriptTimeoutMs(5_000, limits)).toBe(5_000);
    expect(scriptTimeoutMs(10_000_000, limits)).toBe(120_000);
    expect(scriptTimeoutMs(-1, limits)).toBe(30_000);
  });
});
