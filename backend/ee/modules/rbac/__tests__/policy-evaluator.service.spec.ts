import { PolicyEvaluatorService } from '../policy-evaluator.service';
import { AbacPolicy } from '../../../../src/entities/abac-policy.entity';

function policy(p: Partial<AbacPolicy>): AbacPolicy {
  return {
    id: p.id ?? 'p1',
    organizationId: 'org',
    name: p.name ?? 'policy',
    description: null,
    effect: p.effect ?? 'allow',
    action: p.action ?? '*',
    conditions: p.conditions ?? [],
    priority: p.priority ?? 0,
    active: p.active ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AbacPolicy;
}

describe('PolicyEvaluatorService', () => {
  const svc = new PolicyEvaluatorService();

  describe('permits (custom-role grants)', () => {
    it('matches an exact grant', () => {
      expect(svc.permits(['agents:read'], 'agents:read')).toBe(true);
      expect(svc.permits(['agents:read'], 'agents:write')).toBe(false);
    });

    it('honors resource wildcard', () => {
      expect(svc.permits(['agents:*'], 'agents:write')).toBe(true);
      expect(svc.permits(['agents:*'], 'tools:write')).toBe(false);
    });

    it('honors action wildcard', () => {
      expect(svc.permits(['*:read'], 'tools:read')).toBe(true);
      expect(svc.permits(['*:read'], 'tools:write')).toBe(false);
    });

    it('honors the global wildcard', () => {
      expect(svc.permits(['*'], 'anything:goes')).toBe(true);
    });

    it('fails closed on empty grants', () => {
      expect(svc.permits([], 'agents:read')).toBe(false);
    });
  });

  describe('evaluate (ABAC)', () => {
    it('deny overrides allow regardless of priority', () => {
      const policies = [
        policy({ id: 'a', effect: 'allow', priority: 100 }),
        policy({ id: 'd', effect: 'deny', priority: 1 }),
      ];
      const decision = svc.evaluate(policies, 'tools:execute', {});
      expect(decision.allowed).toBe(false);
      expect(decision.effect).toBe('deny');
      expect(decision.matchedPolicyId).toBe('d');
    });

    it('allows via the highest-priority applicable allow', () => {
      const policies = [
        policy({ id: 'lo', effect: 'allow', priority: 1 }),
        policy({ id: 'hi', effect: 'allow', priority: 5 }),
      ];
      const decision = svc.evaluate(policies, 'tools:execute', {});
      expect(decision.allowed).toBe(true);
      expect(decision.matchedPolicyId).toBe('hi');
    });

    it('fails closed (default deny) when no policy applies', () => {
      const decision = svc.evaluate([], 'tools:execute', {});
      expect(decision.allowed).toBe(false);
      expect(decision.effect).toBe('default');
    });

    it('respects action scoping', () => {
      const policies = [policy({ effect: 'deny', action: 'tools:delete' })];
      // Different action → policy not applicable → default deny (not the deny policy)
      expect(svc.evaluate(policies, 'tools:read', {}).effect).toBe('default');
      expect(svc.evaluate(policies, 'tools:delete', {}).effect).toBe('deny');
    });

    it('evaluates numeric + membership conditions against context', () => {
      const policies = [
        policy({
          id: 'big-refund',
          effect: 'deny',
          action: 'tools:execute',
          conditions: [
            { attr: 'resource.amount', op: 'gt', value: 1000 },
            { attr: 'subject.department', op: 'in', value: ['sales', 'ops'] },
          ],
        }),
      ];
      const hit = svc.evaluate(policies, 'tools:execute', {
        resource: { amount: 5000 },
        subject: { department: 'sales' },
      });
      expect(hit.allowed).toBe(false);

      const miss = svc.evaluate(policies, 'tools:execute', {
        resource: { amount: 50 },
        subject: { department: 'sales' },
      });
      expect(miss.effect).toBe('default');
    });

    it('ignores inactive policies', () => {
      const policies = [policy({ effect: 'deny', active: false })];
      expect(svc.evaluate(policies, 'tools:execute', {}).effect).toBe('default');
    });
  });
});
