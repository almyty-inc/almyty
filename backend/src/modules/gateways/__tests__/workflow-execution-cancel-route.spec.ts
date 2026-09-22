/**
 * POST /:orgSlug/:agentSlug/executions/:executionId/cancel — the workflow
 * counterpart of /runs/:id/cancel (issue #653).
 *
 * A workflow run behind a gateway is an AgentExecution, and the only cancel
 * route was /runs/:id/cancel, which a workflow run is not. A client that
 * cancelled without dropping its SSE connection had nothing to call, so the
 * pipeline ran on and kept billing.
 *
 * Driven through UnifiedAgentHelper.handleAgentRequest, the same entry point
 * the unified endpoint controller uses, so the route's authentication and
 * org scoping are the ones actually served and not a reimplementation.
 */
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ConflictException, NotFoundException } from '@nestjs/common';

import { UnifiedAgentHelper } from '../unified-agent.helper';
import { AgentExecutionCancellationService } from '../../agents/agent-execution-cancellation.service';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { Organization } from '../../../entities/organization.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';

const RAW_KEY = 'ak_test_key';
const KEY_HASH = crypto.createHash('sha256').update(RAW_KEY).digest('hex');

function makeAgent(organizationId = 'org-1'): Agent {
  const agent = new Agent();
  agent.id = 'agent-1';
  agent.name = 'Pipeline Agent';
  agent.organizationId = organizationId;
  agent.status = AgentStatus.ACTIVE;
  agent.mode = 'workflow' as any;
  return agent;
}

function makeOrg(id = 'org-1'): Organization {
  const org = new Organization();
  org.id = id;
  org.slug = 'acme';
  return org;
}

function makeExecutionRow(overrides: Partial<AgentExecution> = {}): AgentExecution {
  const exec = new AgentExecution();
  exec.id = 'exec-1';
  exec.agentId = 'agent-1';
  exec.organizationId = 'org-1';
  exec.status = AgentExecutionStatus.RUNNING;
  exec.error = null as any;
  return Object.assign(exec, overrides);
}

function fakeExecutionRepo(rows: AgentExecution[]) {
  const saved: AgentExecution[] = [];
  return {
    saved,
    save: jest.fn(async (e: AgentExecution) => { saved.push(e); return e; }),
    findOne: jest.fn(async ({ where }: any) =>
      rows.find((r) => Object.entries(where).every(([k, v]) => (r as any)[k] === v)) ?? null,
    ),
  };
}

function fakeRes() {
  const recorded: { status: number; body: any } = { status: 200, body: undefined };
  const res: any = {
    status(code: number) { recorded.status = code; return res; },
    json(body: any) { recorded.body = body; return res; },
    setHeader() { return res; },
    flushHeaders() { return res; },
    write() { return true; },
    end() { return res; },
    writableEnded: false,
  };
  return { res, recorded };
}

function fakeReq(path: string, method = 'POST') {
  return {
    method,
    path,
    headers: { authorization: `Bearer ${RAW_KEY}` },
    on: jest.fn(),
    query: {},
  } as any;
}

function build(rows: AgentExecution[]) {
  const executionRepo = fakeExecutionRepo(rows);
  const cancellations = new AgentExecutionCancellationService(executionRepo as any);
  const apiKeyRepo = {
    findOne: jest.fn(async ({ where }: any) =>
      where.keyHash === KEY_HASH && where.organizationId === 'org-1'
        ? { id: 'key-1', userId: 'user-1', organizationId: 'org-1', isActive: true }
        : null,
    ),
  };
  const helper = new UnifiedAgentHelper(
    { manager: { getRepository: () => ({ find: async () => [] }) } } as any,
    apiKeyRepo as any,
    { execute: jest.fn() } as any,
    { cancelRun: jest.fn() } as any,
    { verify: jest.fn(() => { throw new Error('not a jwt'); }) } as any,
    cancellations,
  );
  return { helper, cancellations, executionRepo, apiKeyRepo };
}

describe('POST /:org/:agent/executions/:id/cancel', () => {
  it('cancels a running workflow execution: signal aborted, CANCELLED persisted', async () => {
    const row = makeExecutionRow();
    const { helper, cancellations, executionRepo } = build([row]);
    const controller = cancellations.register('exec-1', 'org-1');
    const { res, recorded } = fakeRes();

    await helper.handleAgentRequest(
      makeAgent(),
      makeOrg(),
      fakeReq('/acme/pipeline-agent/executions/exec-1/cancel'),
      res,
      {},
    );

    expect(controller.signal.aborted).toBe(true);
    expect(recorded.body).toEqual({ success: true, data: { id: 'exec-1', status: 'cancelled' } });
    expect(executionRepo.saved[0].status).toBe(AgentExecutionStatus.CANCELLED);
  });

  it('refuses to cancel another organization\'s execution', async () => {
    const victim = makeExecutionRow({ organizationId: 'victim-org' });
    const { helper, cancellations, executionRepo } = build([victim]);
    const controller = cancellations.register('exec-1', 'victim-org');
    const { res } = fakeRes();

    // The attacker's own org resolves and authenticates fine; the execution
    // id is simply not theirs.
    await expect(
      helper.handleAgentRequest(
        makeAgent('org-1'),
        makeOrg('org-1'),
        fakeReq('/acme/pipeline-agent/executions/exec-1/cancel'),
        res,
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(controller.signal.aborted).toBe(false);
    expect(executionRepo.save).not.toHaveBeenCalled();
    expect(victim.status).toBe(AgentExecutionStatus.RUNNING);
  });

  it('refuses an execution belonging to a different agent on the same org', async () => {
    const other = makeExecutionRow({ agentId: 'agent-2' });
    const { helper, executionRepo } = build([other]);
    const { res } = fakeRes();

    await expect(
      helper.handleAgentRequest(
        makeAgent(),
        makeOrg(),
        fakeReq('/acme/pipeline-agent/executions/exec-1/cancel'),
        res,
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(executionRepo.save).not.toHaveBeenCalled();
  });

  it('cancelling a finished execution is a 409, not a crash', async () => {
    const done = makeExecutionRow({ status: AgentExecutionStatus.COMPLETED });
    const { helper, executionRepo } = build([done]);
    const { res } = fakeRes();

    await expect(
      helper.handleAgentRequest(
        makeAgent(),
        makeOrg(),
        fakeReq('/acme/pipeline-agent/executions/exec-1/cancel'),
        res,
        {},
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(executionRepo.save).not.toHaveBeenCalled();
  });

  it('requires authentication, like every other agent route', async () => {
    const { helper } = build([makeExecutionRow()]);
    const { res } = fakeRes();
    const req = fakeReq('/acme/pipeline-agent/executions/exec-1/cancel');
    req.headers = {};

    await expect(
      helper.handleAgentRequest(makeAgent(), makeOrg(), req, res, {}),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('a GET on the cancel path is not a cancel', async () => {
    const row = makeExecutionRow();
    const { helper, executionRepo } = build([row]);
    const { res } = fakeRes();

    await expect(
      helper.handleAgentRequest(
        makeAgent(),
        makeOrg(),
        fakeReq('/acme/pipeline-agent/executions/exec-1/cancel', 'GET'),
        res,
        {},
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(executionRepo.save).not.toHaveBeenCalled();
  });
});

/**
 * The dependency is @Optional() so a positionally-constructed spec keeps
 * compiling, which means a broken DI wire would not throw at boot -- it
 * would answer 503 on the one route that matters and nowhere else. Read the
 * modules so that failure cannot happen quietly.
 */
describe('the cancel route is wired, not just written', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

  it('AgentsModule provides and exports the cancellation service', () => {
    const agentsModule = read('agents/agents.module.ts');
    const providers = agentsModule.slice(agentsModule.indexOf('providers: ['), agentsModule.indexOf('controllers: ['));
    const exports = agentsModule.slice(agentsModule.indexOf('exports: ['));
    expect(providers).toContain('AgentExecutionCancellationService');
    expect(exports).toContain('AgentExecutionCancellationService');
  });

  it('the module that provides UnifiedAgentHelper imports AgentsModule', () => {
    const unified = read('gateways/unified-endpoint.module.ts');
    expect(unified).toContain('UnifiedAgentHelper');
    expect(unified).toContain('AgentsModule');
  });

  it('the engine runs on the registry signal, not the caller signal', () => {
    const engine = read('agents/agent-execution.engine.ts');
    // The registration and the between-layer check have to name the same
    // signal, or a cancel aborts a controller the engine never reads.
    expect(engine).toContain('this.cancellations?.register(execution.id, organizationId, options.signal)');
    expect(engine).toContain('if (runSignal?.aborted)');
    expect(engine).toContain('this.cancellations?.release(execution.id)');
  });
});
