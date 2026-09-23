import { readFileSync } from 'fs';
import { join } from 'path';

import { ApprovalPolicyEvaluator } from '../approval-policy.evaluator';
import { ApprovalPolicy } from '../../../../src/entities/approval-policy.entity';

/**
 * A team-scoped approval policy governs that team and no one else.
 *
 * `approval_policies.teamId` had a column, a CreateApprovalPolicyInput
 * field, a patch branch in the service and an entity comment saying it
 * "mirrors approval_requests visibility model". resolvePolicy filtered
 * on `enabled` and `match` and nothing else, so a policy configured for
 * one team was the governing policy for every request in the
 * organization: people were gated by a rule that was never written for
 * them, and their approvals were scored and reported against a team they
 * are not on.
 *
 * ApprovalsService.resolveGoverningPolicy already put the request's
 * `teamId` in the context, which is what made this an omission in the
 * filter rather than missing plumbing.
 *
 * The behavioural half of this guard is the real proof -- the evaluator
 * is pure, so a test can state the rule directly. The textual half pins
 * the context key: resolveGoverningPolicy is free to stop sending
 * `teamId`, and then the filter would silently match nothing but
 * org-wide policies again.
 */
describe('a team-scoped approval policy scopes to its team', () => {
  const evaluator = new ApprovalPolicyEvaluator();

  const policy = (over: Partial<ApprovalPolicy>): ApprovalPolicy =>
    ({
      id: 'p1',
      organizationId: 'org-1',
      name: 'two approvals',
      description: null,
      teamId: null,
      match: [],
      steps: [{ name: 'any', approverRole: '*', minApprovals: 2 }],
      priority: 0,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as ApprovalPolicy;

  it('does not govern a request from another team', () => {
    const p = policy({ teamId: 'team-payments' });
    expect(evaluator.resolvePolicy([p], { teamId: 'team-support' })).toBeNull();
  });

  it('does not govern an org-wide request', () => {
    const p = policy({ teamId: 'team-payments' });
    expect(evaluator.resolvePolicy([p], { teamId: null })).toBeNull();
    expect(evaluator.resolvePolicy([p], {})).toBeNull();
  });

  it('governs a request from its own team', () => {
    const p = policy({ teamId: 'team-payments' });
    expect(evaluator.resolvePolicy([p], { teamId: 'team-payments' })?.id).toBe('p1');
  });

  it('an org-wide policy still governs every request', () => {
    const p = policy({ teamId: null });
    expect(evaluator.resolvePolicy([p], { teamId: 'team-payments' })?.id).toBe('p1');
    expect(evaluator.resolvePolicy([p], {})?.id).toBe('p1');
  });

  it('priority is decided among the policies that actually apply', () => {
    // The out-of-team policy has the higher priority. If team scope were
    // dropped it would win, which is the exact shape of the original bug.
    const foreign = policy({ id: 'foreign', teamId: 'team-payments', priority: 10 });
    const orgWide = policy({ id: 'org-wide', teamId: null, priority: 1 });
    expect(evaluator.resolvePolicy([foreign, orgWide], { teamId: 'team-support' })?.id).toBe(
      'org-wide',
    );
  });

  it('ApprovalsService still hands the evaluator a teamId to filter on', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'src', 'modules', 'approvals', 'approvals.service.ts'),
      'utf8',
    );
    const at = source.indexOf('resolveForContext(input.organizationId, {');
    expect(at).toBeGreaterThan(-1); // update this guard if the call moved
    expect(source.slice(at, at + 400)).toContain('teamId: input.teamId');
  });
});
