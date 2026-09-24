import * as crypto from 'crypto';

import { A2AServerService } from '../../a2a/a2a-server.service';
import { A2AAgentCardService } from '../../a2a/a2a-agent-card.service';
import { A2A_ERROR_CODES } from '../../a2a/types/a2a-spec.types';
import { AcpServerService } from '../../acp/acp-server.service';
import { ACP_ERROR_CODES } from '../../acp/types/acp.types';
import { UnifiedAgentHelper } from '../unified-agent.helper';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { UnifiedEndpointController } from '../unified-endpoint.controller';
import { ApiKey } from '../../../entities/api-key.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';

/**
 * An A2A or ACP gateway serves one agent. Every run a client names -- a
 * task id, a session id, a context or conversation id -- has to be a run of
 * THAT agent; anything else is the same not-found an unknown id gets.
 *
 * These lookups used to be scoped to the organization only, so a client of
 * one agent's gateway could read another agent's conversation (tasks/get,
 * session/get), cancel its run (tasks/cancel, session/cancel), stream it
 * (tasks/resubscribe), or feed input into another agent's waiting run
 * (message/send with its contextId, session/prompt with its sessionId) --
 * executing an agent the gateway never published. The unified endpoint had
 * the same gap one level up: a gateway's API key ran any agent of the
 * organization through /:org/:agent, and the root A2A endpoint served
 * whichever agent-bearing gateway a key matched, hosted chat included.
 *
 * Real A2AServerService, AcpServerService, UnifiedAgentHelper and
 * UnifiedEndpointController; tables are truthful fakes; the runtime double
 * records what it was asked to do and writes the runs it starts into the
 * same table.
 */
describe('an agent gateway serves only its own agent (A2A, ACP, the unified endpoint)', () => {
  const ORG = 'org-1';
  const PUBLISHED = 'agent-published';
  const OTHER = 'agent-other';
  const UNKNOWN = '00000000-0000-4000-8000-00000000dead';
  const OWN_WAITING = '10000000-0000-4000-8000-000000000001';
  const FOREIGN_WAITING = '20000000-0000-4000-8000-000000000001';
  const FOREIGN_RUNNING = '20000000-0000-4000-8000-000000000002';
  const OWN_CONV = '30000000-0000-4000-8000-000000000001';
  const FOREIGN_CONV = '40000000-0000-4000-8000-000000000001';

  const gateway: any = { id: 'gw-a', organizationId: ORG, agentId: PUBLISHED, authConfigs: [], endpoint: '/a' };
  const req: any = { protocol: 'https', get: () => 'api.example.com', on: jest.fn() };

  let runs: ReturnType<typeof fakeRepository<AgentRun>>;
  let runtime: {
    startRun: jest.Mock;
    sendInput: jest.Mock;
    cancelRun: jest.Mock;
    getRun: jest.Mock;
    getRunEmitter: jest.Mock;
  };
  let a2a: A2AServerService;
  let acp: AcpServerService;

  const response = () => {
    const res: any = { body: undefined };
    res.json = jest.fn((b: any) => (res.body = b));
    res.setHeader = jest.fn();
    res.flushHeaders = jest.fn();
    res.write = jest.fn();
    res.end = jest.fn();
    return res;
  };

  beforeEach(() => {
    const at = new Date(Date.now() - 60_000);
    runs = fakeRepository<AgentRun>({
      make: () => new AgentRun(),
      idPrefix: 'run',
      seed: [
        { id: OWN_WAITING, agentId: PUBLISHED, organizationId: ORG, status: AgentRunStatus.WAITING_INPUT, conversationId: OWN_CONV, createdAt: at, metadata: {} },
        { id: FOREIGN_WAITING, agentId: OTHER, organizationId: ORG, status: AgentRunStatus.WAITING_INPUT, conversationId: FOREIGN_CONV, createdAt: at, metadata: {} },
        { id: FOREIGN_RUNNING, agentId: OTHER, organizationId: ORG, status: AgentRunStatus.RUNNING, conversationId: FOREIGN_CONV, createdAt: at, metadata: {} },
      ],
    });
    runtime = {
      startRun: jest.fn(async (agentId: string, organizationId: string, _u: any, _t: any, opts: any = {}) =>
        runs.save(
          Object.assign(new AgentRun(), {
            agentId,
            organizationId,
            status: AgentRunStatus.COMPLETED,
            conversationId: opts.conversationId ?? null,
            createdAt: at,
            metadata: {},
          }),
        ),
      ),
      sendInput: jest.fn(async (runId: string) => runs.row(runId)),
      cancelRun: jest.fn(async (runId: string) => {
        await runs.update({ id: runId }, { status: AgentRunStatus.CANCELLED });
        return runs.row(runId);
      }),
      getRun: jest.fn(async (runId: string) => runs.row(runId)),
      getRunEmitter: jest.fn().mockReturnValue(null),
    };
    const messages = fakeRepository<any>([]);
    a2a = new A2AServerService(runtime as any, new A2AAgentCardService(), runs as any, fakeRepository<any>([]) as any, messages as any);
    acp = new AcpServerService(runtime as any, runs as any, messages as any);
  });

  const a2aCall = async (method: string, params: any) => {
    const res = response();
    await a2a.handleJsonRpc(gateway, req, { jsonrpc: '2.0', id: 1, method, params }, res);
    return res.body;
  };
  const acpCall = async (method: string, params: any) => {
    const res = response();
    await acp.handleJsonRpc(gateway, req, { jsonrpc: '2.0', id: 1, method, params }, res);
    return res.body;
  };
  const errorOf = (body: any) => body?.error && { code: body.error.code, message: body.error.message };
  const text = (t: string) => ({ parts: [{ kind: 'text', text: t }], role: 'user', messageId: 'm-1' });
  const acpText = (t: string) => ({ parts: [{ type: 'text', text: t }] });

  describe('A2A', () => {
    it.each([['tasks/get'], ['tasks/cancel']])('%s on another agent\'s run is the not-found an unknown id gets', async (method) => {
      const unknown = errorOf(await a2aCall(method, { id: UNKNOWN }));
      expect(unknown).toMatchObject({ code: A2A_ERROR_CODES.TASK_NOT_FOUND });
      expect(errorOf(await a2aCall(method, { id: FOREIGN_RUNNING }))).toEqual(unknown);
      expect(runtime.cancelRun).not.toHaveBeenCalled();
      expect(runs.row(FOREIGN_RUNNING)!.status).toBe(AgentRunStatus.RUNNING);
    });

    it('tasks/get still answers for the gateway\'s own agent', async () => {
      expect((await a2aCall('tasks/get', { id: OWN_WAITING })).result).toMatchObject({ id: OWN_WAITING });
    });

    it('tasks/resubscribe to another agent\'s run is not found', async () => {
      const res = response();
      const unknownRes = response();
      await a2a.handleJsonRpc(gateway, req, { jsonrpc: '2.0', id: 1, method: 'tasks/resubscribe', params: { id: FOREIGN_RUNNING } }, res);
      await a2a.handleJsonRpc(gateway, req, { jsonrpc: '2.0', id: 1, method: 'tasks/resubscribe', params: { id: UNKNOWN } }, unknownRes);
      expect(errorOf(res.body)).toEqual(errorOf(unknownRes.body));
      expect(errorOf(res.body)).toMatchObject({ code: A2A_ERROR_CODES.TASK_NOT_FOUND });
      expect(res.write).not.toHaveBeenCalled();
    });

    it('message/send continuing another agent\'s task id is not found, and starts nothing', async () => {
      const unknown = errorOf(await a2aCall('message/send', { message: { ...text('hi'), taskId: UNKNOWN } }));
      expect(unknown).toMatchObject({ code: A2A_ERROR_CODES.TASK_NOT_FOUND });
      expect(errorOf(await a2aCall('message/send', { message: { ...text('hi'), taskId: FOREIGN_RUNNING } }))).toEqual(unknown);
      expect(runtime.startRun).not.toHaveBeenCalled();
    });

    it('message/send with another agent\'s context id never feeds that agent\'s waiting run', async () => {
      await a2aCall('message/send', { contextId: FOREIGN_CONV, message: text('take this') });
      expect(runtime.sendInput).not.toHaveBeenCalled();
      // Treated as a context this gateway has never seen: a fresh run of
      // its own agent.
      expect(runtime.startRun).toHaveBeenCalledTimes(1);
      expect(runtime.startRun.mock.calls[0][0]).toBe(PUBLISHED);
    });

    it('message/send with its own context id still resumes its own waiting run', async () => {
      await a2aCall('message/send', { contextId: OWN_CONV, message: text('go on') });
      expect(runtime.sendInput).toHaveBeenCalledWith(OWN_WAITING, ORG, 'go on');
    });

    it('message/stream with another agent\'s context id never feeds that agent\'s waiting run', async () => {
      const res = response();
      await a2a.handleJsonRpc(gateway, req, { jsonrpc: '2.0', id: 1, method: 'message/stream', params: { contextId: FOREIGN_CONV, message: text('x') } }, res);
      expect(runtime.sendInput).not.toHaveBeenCalled();
      expect(runtime.startRun.mock.calls[0][0]).toBe(PUBLISHED);
    });
  });

  describe('ACP', () => {
    it.each([['session/get'], ['session/cancel']])('%s on another agent\'s run is the not-found an unknown id gets', async (method) => {
      const unknown = errorOf(await acpCall(method, { sessionId: UNKNOWN }));
      expect(unknown).toMatchObject({ code: ACP_ERROR_CODES.SESSION_NOT_FOUND });
      expect(errorOf(await acpCall(method, { sessionId: FOREIGN_RUNNING }))).toEqual(unknown);
      expect(runtime.cancelRun).not.toHaveBeenCalled();
      expect(runs.row(FOREIGN_RUNNING)!.status).toBe(AgentRunStatus.RUNNING);
    });

    it('session/get and session/cancel still work on the gateway\'s own agent', async () => {
      expect((await acpCall('session/get', { sessionId: OWN_WAITING })).result).toMatchObject({ sessionId: OWN_WAITING });
      expect((await acpCall('session/cancel', { sessionId: OWN_WAITING })).error).toBeUndefined();
      expect(runtime.cancelRun).toHaveBeenCalledWith(OWN_WAITING, ORG);
    });

    it.each([
      ['by run id', FOREIGN_WAITING],
      ['by conversation id', FOREIGN_CONV],
    ])('session/prompt naming another agent\'s waiting run %s never feeds it', async (_l, sessionId) => {
      await acpCall('session/prompt', { sessionId, message: acpText('take this') });
      expect(runtime.sendInput).not.toHaveBeenCalled();
      expect(runtime.startRun).toHaveBeenCalledTimes(1);
      expect(runtime.startRun.mock.calls[0][0]).toBe(PUBLISHED);
    });

    it('session/stream naming another agent\'s waiting run never feeds it', async () => {
      await acpCall('session/stream', { sessionId: FOREIGN_WAITING, message: acpText('x') });
      expect(runtime.sendInput).not.toHaveBeenCalled();
      expect(runtime.startRun.mock.calls[0][0]).toBe(PUBLISHED);
    });

    it('session/prompt on its own waiting run still resumes it', async () => {
      await acpCall('session/prompt', { sessionId: OWN_WAITING, message: acpText('go on') });
      expect(runtime.sendInput).toHaveBeenCalledWith(OWN_WAITING, ORG, 'go on');
    });
  });

  describe('the unified agent endpoint (/:org/:agent) with a gateway or agent key', () => {
    const AGENT_A = 'agent-a';
    const AGENT_B = 'agent-b';
    const keyFor = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');

    let helper: UnifiedAgentHelper;
    let startRun: jest.Mock;

    const agentRow = (id: string) =>
      Object.assign(new Agent(), { id, name: id, organizationId: ORG, status: AgentStatus.ACTIVE, mode: 'autonomous', visibility: 'org', toolIds: [] });

    beforeEach(() => {
      const agents = fakeRepository<Agent>({ seed: [agentRow(AGENT_A), agentRow(AGENT_B)], make: () => new Agent() });
      const gateways = fakeRepository<Gateway>({
        make: () => new Gateway(),
        seed: [
          { id: 'gw-a2a', organizationId: ORG, type: GatewayType.A2A, status: GatewayStatus.ACTIVE, agentId: AGENT_A, visibility: 'org' },
          { id: 'gw-mcp', organizationId: ORG, type: GatewayType.MCP, status: GatewayStatus.ACTIVE, visibility: 'org' },
        ] as any,
      });
      fakeManager([[Agent, agents], [Gateway, gateways]]);
      const base = { organizationId: ORG, userId: 'user-1', isActive: true, expiresAt: null };
      const apiKeys = fakeRepository<any>([
        { id: 'k-platform', keyHash: keyFor('platform'), ...base },
        { id: 'k-a2a', keyHash: keyFor('a2a-gateway'), gatewayId: 'gw-a2a', ...base },
        { id: 'k-mcp', keyHash: keyFor('mcp-gateway'), gatewayId: 'gw-mcp', ...base },
        { id: 'k-agent-a', keyHash: keyFor('agent-a-only'), agentId: AGENT_A, ...base },
      ]);
      startRun = jest.fn(async () => ({ id: 'run-new' }));
      const m = membershipFixture();
      m.member(ORG, 'user-1');
      helper = new UnifiedAgentHelper(
        agents as any,
        apiKeys as any,
        { execute: jest.fn() } as any,
        { startRun, executionAccess: m.executionAccess } as any,
        { verify: jest.fn(() => { throw new Error('not a jwt'); }) } as any,
      );
    });

    const invoke = async (agentId: string, rawKey: string) => {
      const res = response();
      res.status = jest.fn(() => res);
      const request: any = { method: 'POST', path: `/acme/${agentId}`, headers: { authorization: `Bearer ${rawKey}` }, on: jest.fn(), query: {} };
      return helper
        .handleAgentRequest(agentRow(agentId), { id: ORG, slug: 'acme' } as any, request, res, { input: 'hi' })
        .then(
          () => ({ ran: startRun.mock.calls.map((c) => c[0]) }),
          (e: any) => ({ status: e.getStatus?.(), message: e.message }),
        );
    };

    it('a platform key reaches the organization\'s agents', async () => {
      expect(await invoke(AGENT_A, 'platform')).toEqual({ ran: [AGENT_A] });
    });

    it('a gateway key reaches the agent its gateway publishes', async () => {
      expect(await invoke(AGENT_A, 'a2a-gateway')).toEqual({ ran: [AGENT_A] });
    });

    it.each([
      ['an agent gateway\'s key, for another agent', AGENT_B, 'a2a-gateway'],
      ['a tool gateway\'s key, for any agent', AGENT_A, 'mcp-gateway'],
      ['a key minted for one agent, for another agent', AGENT_B, 'agent-a-only'],
    ])('%s is the not-found an unknown agent gets, and runs nothing', async (_l, agentId, rawKey) => {
      expect(await invoke(agentId, rawKey)).toEqual({ status: 404, message: `Resource not found: acme/${agentId}` });
      expect(startRun).not.toHaveBeenCalled();
    });
  });

  describe('the root A2A endpoint (POST /) picks an A2A gateway only', () => {
    const keyFor = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');
    let controller: UnifiedEndpointController;
    let served: jest.Mock;

    beforeEach(() => {
      // Seeded ahead of the A2A gateway, so a lookup that ignores the type
      // finds these first.
      const gateways = fakeRepository<Gateway>({
        make: () => new Gateway(),
        seed: [
          { id: 'gw-chat', organizationId: ORG, type: GatewayType.HOSTED_CHAT, status: GatewayStatus.ACTIVE, agentId: 'agent-chat', visibility: 'org' },
          { id: 'gw-slack', organizationId: ORG, type: GatewayType.SLACK, status: GatewayStatus.ACTIVE, agentId: 'agent-slack', visibility: 'org' },
          { id: 'gw-a2a', organizationId: ORG, type: GatewayType.A2A, status: GatewayStatus.ACTIVE, agentId: PUBLISHED, visibility: 'org' },
        ] as any,
      });
      const base = { organizationId: ORG, userId: 'user-1', isActive: true, expiresAt: null };
      const apiKeys = fakeRepository<ApiKey>({
        make: () => new ApiKey(),
        seed: [
          { id: 'k-org', keyHash: keyFor('org-key'), gatewayId: null, ...base },
          { id: 'k-chat', keyHash: keyFor('chat-key'), gatewayId: 'gw-chat', ...base },
          { id: 'k-a2a', keyHash: keyFor('a2a-key'), gatewayId: 'gw-a2a', ...base },
        ] as any,
      });
      served = jest.fn(async (_gw: any, _req: any, _body: any, res: any) => res.json({ ok: true }));
      controller = new UnifiedEndpointController(
        {} as any,
        gateways as any,
        {} as any,
        apiKeys as any,
        {} as any,
        { handleJsonRpc: served } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    const post = async (rawKey: string) => {
      const res = response();
      res.status = jest.fn(() => res);
      const request: any = { method: 'POST', headers: { 'x-api-key': rawKey } };
      await controller.handleRootJsonRpc(request, res, { jsonrpc: '2.0', id: 1, method: 'message/send', params: {} });
      return { gatewayId: served.mock.calls[0]?.[0]?.id ?? null, body: res.body };
    };

    it('serves the A2A gateway a key was minted for', async () => {
      expect((await post('a2a-key')).gatewayId).toBe('gw-a2a');
    });

    it('an organization key reaches an A2A gateway, not whichever agent surface comes first', async () => {
      expect((await post('org-key')).gatewayId).toBe('gw-a2a');
    });

    it('a hosted-chat gateway\'s key does not turn its agent into an A2A endpoint', async () => {
      const out = await post('chat-key');
      expect(out.gatewayId).toBeNull();
      expect(out.body.error).toMatchObject({ message: 'No agent gateway found for this key' });
    });
  });
});
