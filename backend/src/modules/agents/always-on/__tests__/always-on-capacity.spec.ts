import {
  ALWAYS_ON_CAPACITY_ENV,
  ALWAYS_ON_PLAN_DEFAULTS,
  alwaysOnCapacity,
  effectiveTimerMinutes,
  effectiveWakesPerHour,
  planCapacity,
} from '../always-on-capacity';
import { defaultAlwaysOn, isReadOnlyTool, mergeAlwaysOn, readAlwaysOn } from '../always-on.types';

describe('Always on capacity: configuration, never constants', () => {
  it('seeds the plan catalog with the agreed defaults', () => {
    expect(ALWAYS_ON_PLAN_DEFAULTS.free).toEqual({ timerFloorMinutes: 15, maxWakesPerHour: 6, includedAgents: null });
    expect(ALWAYS_ON_PLAN_DEFAULTS.pro).toEqual({ timerFloorMinutes: 5, maxWakesPerHour: 12, includedAgents: 3 });
    expect(planCapacity('business', {}).timerFloorMinutes).toBe(5);
  });

  it('reads an unknown plan as free', () => {
    expect(planCapacity('mystery', {})).toEqual(ALWAYS_ON_PLAN_DEFAULTS.free);
    expect(planCapacity(null, {})).toEqual(ALWAYS_ON_PLAN_DEFAULTS.free);
  });

  it('lets the install override any of it', () => {
    const env = { [ALWAYS_ON_CAPACITY_ENV]: JSON.stringify({ free: { timerFloorMinutes: 10 }, pro: { includedAgents: 5, maxWakesPerHour: 30 } }) };
    expect(planCapacity('free', env)).toEqual({ timerFloorMinutes: 10, maxWakesPerHour: 6, includedAgents: null });
    expect(planCapacity('pro', env)).toEqual({ timerFloorMinutes: 5, maxWakesPerHour: 30, includedAgents: 5 });
  });

  it('ignores an override that is not JSON or not a positive number', () => {
    expect(planCapacity('free', { [ALWAYS_ON_CAPACITY_ENV]: 'not json' })).toEqual(ALWAYS_ON_PLAN_DEFAULTS.free);
    expect(planCapacity('free', { [ALWAYS_ON_CAPACITY_ENV]: '{"free":{"timerFloorMinutes":-3}}' }).timerFloorMinutes).toBe(15);
  });

  it('lets an organization tighten its own, never loosen', () => {
    const org = (alwaysOn: any) => ({ plan: 'pro', settings: { alwaysOn } });
    expect(alwaysOnCapacity(org({ timerFloorMinutes: 30, maxWakesPerHour: 2 }), {})).toMatchObject({ timerFloorMinutes: 30, maxWakesPerHour: 2 });
    expect(alwaysOnCapacity(org({ timerFloorMinutes: 1, maxWakesPerHour: 100 }), {})).toMatchObject({ timerFloorMinutes: 5, maxWakesPerHour: 12 });
  });

  it('never runs a timer under the floor or more wakes than the plan', () => {
    const cap = ALWAYS_ON_PLAN_DEFAULTS.free;
    expect(effectiveTimerMinutes(5, cap)).toBe(15);
    expect(effectiveTimerMinutes(60, cap)).toBe(60);
    expect(effectiveWakesPerHour(null, cap)).toBe(6);
    expect(effectiveWakesPerHour(50, cap)).toBe(6);
    expect(effectiveWakesPerHour(2, cap)).toBe(2);
  });
});

describe('Always on settings', () => {
  it('reads an old heartbeat as Always on that acts on its own, as it did', () => {
    expect(readAlwaysOn({ enabled: true, intervalMinutes: 20, prompt: 'check' })).toMatchObject({
      enabled: true,
      brief: 'check',
      wakeOn: { timer: { everyMinutes: 20 } },
      actMode: 'act',
    });
  });

  it('a new one asks first', () => {
    expect(defaultAlwaysOn().actMode).toBe('propose');
  });

  it('needs instructions and something that wakes it before it can be on', () => {
    expect(() => mergeAlwaysOn(null, { enabled: true })).toThrow(/what it should keep doing/);
    expect(() =>
      mergeAlwaysOn(null, { enabled: true, brief: 'x', wakeOn: { timer: null, channelIds: [], connectionEvents: [] } }),
    ).toThrow(/at least one thing that wakes it/);
  });

  it('keeps what the system owns (the standing thread) across a change', () => {
    const current = { ...defaultAlwaysOn(), brief: 'x', standingConversationId: 'conv-1', liveRunId: 'run-1' };
    expect(mergeAlwaysOn(current, { brief: 'y' })).toMatchObject({ brief: 'y', standingConversationId: 'conv-1', liveRunId: 'run-1' });
  });

  it('refuses an unknown connection event and an owner channel without an address', () => {
    expect(() => mergeAlwaysOn(null, { wakeOn: { connectionEvents: ['exploded' as any] } })).toThrow(/Unknown connection event/);
    expect(() => mergeAlwaysOn(null, { ownerChannel: { channelId: '44444444-4444-4444-8444-444444444444', address: ' ' } })).toThrow(/your own address/);
  });

  it('counts only read tools as read-only', () => {
    expect(isReadOnlyTool({ sideEffect: 'read' })).toBe(true);
    expect(isReadOnlyTool({ sideEffect: 'write' })).toBe(false);
    expect(isReadOnlyTool({ sideEffect: 'destructive' })).toBe(false);
    expect(isReadOnlyTool({})).toBe(false);
  });
});
