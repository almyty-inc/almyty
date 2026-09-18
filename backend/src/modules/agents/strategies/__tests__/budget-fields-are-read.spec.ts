import { readFileSync } from 'fs';
import { join } from 'path';

import { BudgetPolicy, evaluateBudget, StageProjection } from '../budget-policy';

/**
 * A budget field that nothing reads is a gate that never closes.
 *
 * `ceilingPerTask` sat on `BudgetPolicy` and in `docs/budgets.md` for
 * months and was read by nothing: `evaluateBudget` consulted `stopWhen`
 * and then `ceilingPerRun` and returned continue. Anyone who set it
 * believed they had a spend gate. This guard is cheap and it makes the
 * next such field impossible to land quietly.
 */
describe('every budget policy field is one the evaluator actually reads', () => {
  const source = readFileSync(join(__dirname, '..', 'budget-policy.ts'), 'utf8');

  /** The field names declared on an interface in the source, at one nesting level. */
  const fieldsOf = (interfaceName: string): string[] => {
    const start = source.indexOf(`export interface ${interfaceName} {`);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start));
    return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  };

  it('reads every top-level field of BudgetPolicy', () => {
    const body = source.slice(source.indexOf('export function evaluateBudget'));
    const unread = fieldsOf('BudgetPolicy').filter((field) => !body.includes(`policy.${field}`));
    expect(unread).toEqual([]);
  });

  it('reads every stopWhen rule', () => {
    const body = source.slice(source.indexOf('export function evaluateBudget'));
    // The evaluator destructures stopWhen, so the rules are read as `stop.<x>`.
    const rules = ['verifierPasses', 'confidenceAbove', 'marginalGainBelow'];
    expect(rules.filter((rule) => !body.includes(`stop.${rule}`))).toEqual([]);
  });

  it('has no per-task ceiling, because nothing in the product has a task identity', () => {
    // If a task identity is ever added, this is the test to delete — and
    // deleting it should mean implementing the gate, not just the field.
    expect(source).not.toContain('ceilingPerTask');
    expect(fieldsOf('BudgetPolicy')).toEqual(['ceilingPerRun', 'stopWhen', 'onExceed']);
  });

  it('still gates on the run ceiling, sub-agent spend included', () => {
    const policy: BudgetPolicy = { ceilingPerRun: 100 };
    // A sub_agent node reports its whole nested run as its own cost, so
    // spentCents already carries it.
    const projection: StageProjection = { spentCents: 90, nextStageCents: 20 };
    expect(evaluateBudget(policy, projection)).toMatchObject({ action: 'stop' });
  });
});
