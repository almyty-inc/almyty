/**
 * A real ToolExecutorService with a real ToolApprovalGateService in front
 * of it, over truthful fake tables. Only the upstream HTTP call (axios, which
 * the spec mocks) and the tool's plumbing that the gate does not touch are
 * doubles.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 */
import { EventEmitter } from 'events';

import { ToolExecutorService } from '../tool-executor.service';
import { ApprovalsService } from '../../approvals/approvals.service';
import { ToolApprovalGateService } from '../tool-approval-gate.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import type { ExecutionAccessService } from '../../../common/authorization/execution-access.service';

export const REFUND_TOOL = {
  id: 'tool-refund',
  name: 'issue_refund',
  description: 'Refund an order',
  organizationId: 'org-1',
  status: ToolStatus.ACTIVE,
  type: ToolType.API,
  visibility: 'org',
  teamId: null,
  createdBy: 'u-1',
  httpConfig: { method: 'POST', path: 'https://billing.example.com/refunds' },
  parameters: {
    type: 'object',
    properties: { amount: { type: 'number' }, order: { type: 'string' } },
  },
  configuration: {},
  api: null,
  operation: null,
};

/** "Ask before issue_refund when amount is over 500", on the whole organization. */
export const REFUNDS_OVER_500 = {
  id: 'policy-refunds',
  organizationId: 'org-1',
  name: 'Refunds over 500',
  description: null,
  teamId: null,
  match: [],
  steps: [{ name: 'Finance', approverRole: '*', minApprovals: 1 }],
  priority: 0,
  enabled: true,
  trigger: { kind: 'tool_amount', toolId: 'tool-refund', toolName: 'issue_refund', argument: 'amount', op: 'gt', amount: 500 },
};

/**
 * The approvals service as far as a held call sees it: `create` files a
 * pending request in the same table the gate reads, and `decide` flips it
 * and emits 'approval.decided' the way ApprovalsService.decide does (its
 * own specs cover who may decide).
 */
export class FakeApprovals extends EventEmitter {
  created: any[] = [];
  constructor(private readonly rows: ReturnType<typeof fakeRepository<any>>) {
    super();
  }
  async create(input: any) {
    const { principal: _p, teamId: _t, ttlSeconds: _ttl, ...rest } = input;
    const saved = await this.rows.save({ ...rest, status: 'pending', result: null, resultAt: null, decisionReason: null });
    this.created.push(saved);
    return saved;
  }
  async findInOrganization(id: string, organizationId: string) {
    return this.rows.findOne({ where: { id, organizationId } });
  }
  async decide(id: string, status: 'approved' | 'rejected' | 'expired', decisionReason: string | null = null) {
    await this.rows.update({ id }, { status, decisionReason });
    const row = await this.rows.findOne({ where: { id } });
    this.emit('approval.decided', row);
    return row;
  }
}

export function gatedExecutor(
  executionAccess: ExecutionAccessService,
  opts: { policies?: any[]; tools?: any[]; agents?: any[]; runs?: any[] } = {},
) {
  const policies = fakeRepository<any>(opts.policies ?? [REFUNDS_OVER_500]);
  const approvalRequests = fakeRepository<any>({ idPrefix: 'approval' } as any);
  const agents = fakeRepository<any>(opts.agents ?? []);
  // Runs, for an always-on run's ask-first list.
  const runs = fakeRepository<any>(opts.runs ?? []);
  const audit = { log: jest.fn(async () => null) };
  const approvals = new FakeApprovals(approvalRequests);
  let executor: ToolExecutorService;
  const moduleRef = {
    get: (token: unknown) => (token === ApprovalsService ? approvals : token === ToolExecutorService ? executor : null),
  };
  const gate = new ToolApprovalGateService(policies as any, approvalRequests as any, audit as any, agents as any, moduleRef as any, runs as any);
  executor = new ToolExecutorService(
    fakeRepository<any>(opts.tools ?? [REFUND_TOOL]) as any,
    {} as any,
    { findOne: jest.fn().mockResolvedValue({ hasPermissionInOrganization: () => true, organizationMemberships: [] }) } as any,
    {} as any,
    new ToolHttpExecutor({ applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any),
    {} as any,
    {} as any,
    {} as any,
    {
      checkRateLimit: jest.fn().mockResolvedValue({ limited: false }),
      getCachedResult: jest.fn().mockResolvedValue(null),
      cacheResult: jest.fn().mockResolvedValue(undefined),
    } as any,
    { validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }), recordExecution: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    fakeRepository<any>([]) as any,
    undefined,
    executionAccess,
    undefined,
    gate,
  );
  // Subscribes to 'approval.decided', as Nest does at start-up.
  gate.onModuleInit();
  return { executor, gate, policies, approvalRequests, agents, runs, audit, approvals };
}
