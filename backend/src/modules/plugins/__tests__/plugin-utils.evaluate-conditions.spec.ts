import { evaluateConditions } from '../plugin-utils';
import { PluginContext, PluginCondition } from '../types/plugin.types';

function ctx(data: any): PluginContext {
  return { data } as PluginContext;
}

describe('evaluateConditions', () => {
  it('passes when there are no conditions', () => {
    expect(evaluateConditions(undefined, ctx({}))).toBe(true);
    expect(evaluateConditions([], ctx({}))).toBe(true);
  });

  it('equals: matches on value or stringified value', () => {
    const c: PluginCondition[] = [{ type: 'equals', field: 'user.role', value: 'admin' }];
    expect(evaluateConditions(c, ctx({ user: { role: 'admin' } }))).toBe(true);
    expect(evaluateConditions(c, ctx({ user: { role: 'viewer' } }))).toBe(false);
    expect(
      evaluateConditions([{ type: 'equals', field: 'n', value: 5 }], ctx({ n: 5 })),
    ).toBe(true);
  });

  it('contains: substring and array membership', () => {
    expect(
      evaluateConditions([{ type: 'contains', field: 'msg', value: 'err' }], ctx({ msg: 'an error' })),
    ).toBe(true);
    expect(
      evaluateConditions([{ type: 'contains', field: 'tags', value: 'x' }], ctx({ tags: ['a', 'x'] })),
    ).toBe(true);
    expect(
      evaluateConditions([{ type: 'contains', field: 'tags', value: 'z' }], ctx({ tags: ['a', 'x'] })),
    ).toBe(false);
  });

  it('regex: matches and fails closed on invalid patterns', () => {
    expect(
      evaluateConditions([{ type: 'regex', field: 'email', value: '@example\\.com$' }], ctx({ email: 'a@example.com' })),
    ).toBe(true);
    expect(
      evaluateConditions([{ type: 'regex', field: 'email', value: '(' }], ctx({ email: 'x' })),
    ).toBe(false);
  });

  it('AND by default, OR when any condition declares operator:or', () => {
    const data = ctx({ role: 'admin', plan: 'free' });
    const and: PluginCondition[] = [
      { type: 'equals', field: 'role', value: 'admin' },
      { type: 'equals', field: 'plan', value: 'pro' },
    ];
    expect(evaluateConditions(and, data)).toBe(false); // both required, plan fails

    const or: PluginCondition[] = [
      { type: 'equals', field: 'role', value: 'admin', operator: 'or' },
      { type: 'equals', field: 'plan', value: 'pro', operator: 'or' },
    ];
    expect(evaluateConditions(or, data)).toBe(true); // role matches
  });

  it('does not block on a custom condition type it cannot evaluate', () => {
    expect(
      evaluateConditions([{ type: 'custom', field: 'x', value: 'y' }], ctx({ x: 1 })),
    ).toBe(true);
  });

  it('uses own-property traversal (no prototype walk)', () => {
    expect(
      evaluateConditions([{ type: 'equals', field: '__proto__.polluted', value: 'yes' }], ctx({})),
    ).toBe(false);
  });
});
