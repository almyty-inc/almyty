import { membershipFixture } from '../../../test/execution-access.fixture';
/**
 * GET /:orgSlug/:agentSlug/runs/:runId/stream, the run stream an API key
 * reads (@almyty/client's GatewayClient.streamRun, the chat CLI).
 *
 * It streamed whatever run id it was given, without asking whose run it
 * was. It now checks the run is the key's organization's and this agent's
 * before anything is sent, and resumes the way the dashboard's run stream
 * does: `Last-Event-ID` or `?after=<seq>` for the run's log, `?live=<pos>`
 * for its runtime events.
 */
import * as crypto from 'crypto';
import { NotFoundException } from '@nestjs/common';

import { UnifiedAgentHelper } from '../unified-agent.helper';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { Organization } from '../../../entities/organization.entity';

const RAW_KEY = 'ak_test_key';
const KEY_HASH = crypto.createHash('sha256').update(RAW_KEY).digest('hex');

const agent = (): Agent => Object.assign(new Agent(), { id: 'agent-1', name: 'Support', organizationId: 'org-1', status: AgentStatus.ACTIVE, mode: 'autonomous' });
const org = (): Organization => Object.assign(new Organization(), { id: 'org-1', slug: 'acme' });

function fakeRes() {
  const chunks: string[] = [];
  const res: any = {
    chunks,
    headers: {} as Record<string, string>,
    status() { return res; },
    json() { return res; },
    setHeader(k: string, v: string) { res.headers[k] = v; return res; },
    flushHeaders() { return res; },
    write(chunk: string) { chunks.push(chunk); return true; },
    end() { res.writableEnded = true; return res; },
    writableEnded: false,
  };
  return res;
}

const req = (path: string, query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  ({ method: 'GET', path, headers: { authorization: `Bearer ${RAW_KEY}`, ...headers }, on: jest.fn(), query }) as any;

function build() {
  const apiKeyRepo = {
    findOne: jest.fn(async ({ where, relations }: any) =>
      where.keyHash === KEY_HASH && where.organizationId === 'org-1'
        ? {
            id: 'key-1',
            userId: 'user-1',
            organizationId: 'org-1',
            isActive: true,
            ...(relations?.user
              ? { user: { id: 'user-1', isActive: true, organizationMemberships: [{ userId: 'user-1', organizationId: 'org-1', isActive: true, inviteAccepted: true }] } }
              : {}),
          }
        : null,
    ),
  };
  const runtime = {
    executionAccess: membershipFixture().executionAccess,
    getRun: jest.fn(async (runId: string, organizationId: string, agentId?: string) => {
      if (runId !== 'run-1' || organizationId !== 'org-1' || agentId !== 'agent-1') throw new NotFoundException('Run not found');
      return { id: runId };
    }),
    subscribeRunEvents: jest.fn(async (_runId: string, handler: (e: any, id?: string) => void) => {
      handler({ type: 'llm.chunk', data: { content: 'hi' }, timestamp: 't' }, '5-0');
    }),
    subscribeRunLog: jest.fn(async (_runId: string, after: number, onLog: (e: any) => void, onEvent: (e: any, id?: string) => void) => {
      onLog({ runId: 'run-1', seq: after + 1, type: 'step_committed', step: 0, payload: { status: 'running' }, createdAt: new Date('2026-10-28T10:00:00Z') });
      onEvent({ type: 'llm.chunk', data: { content: 'hi' }, timestamp: 't' }, '7-0');
    }),
  };
  const helper = new UnifiedAgentHelper(
    { manager: { getRepository: () => ({ find: async () => [] }) } } as any,
    apiKeyRepo as any,
    { execute: jest.fn() } as any,
    runtime as any,
    { verify: jest.fn(() => { throw new Error('not a jwt'); }) } as any,
  );
  return { helper, runtime };
}

describe('GET /:org/:agent/runs/:runId/stream', () => {
  it('refuses a run that is not this organization\'s and agent\'s, before anything is sent', async () => {
    const { helper, runtime } = build();
    const res = fakeRes();
    await expect(helper.handleAgentRequest(agent(), org(), req('/acme/support/runs/run-of-someone-else/stream'), res, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(runtime.getRun).toHaveBeenCalledWith('run-of-someone-else', 'org-1', 'agent-1');
    expect(res.chunks).toEqual([]);
    expect(runtime.subscribeRunEvents).not.toHaveBeenCalled();
    expect(runtime.subscribeRunLog).not.toHaveBeenCalled();
  });

  it('without a seq: the live stream as before', async () => {
    const { helper, runtime } = build();
    const res = fakeRes();
    await helper.handleAgentRequest(agent(), org(), req('/acme/support/runs/run-1/stream'), res, {});
    expect(runtime.subscribeRunLog).not.toHaveBeenCalled();
    expect(res.chunks).toEqual([`event: llm.chunk\ndata: ${JSON.stringify({ type: 'llm.chunk', data: { content: 'hi' }, timestamp: 't' })}\n\n`]);
    expect(res.writableEnded).toBe(true);
  });

  it('Last-Event-ID resumes the log after that seq; runtime events carry their pos, and ?live= starts them after one', async () => {
    const { helper, runtime } = build();
    const res = fakeRes();
    await helper.handleAgentRequest(
      agent(),
      org(),
      req('/acme/support/runs/run-1/stream', { after: '2', live: '6-0' }, { 'last-event-id': '4' }),
      res,
      {},
    );
    expect(runtime.subscribeRunLog).toHaveBeenCalledWith('run-1', 4, expect.any(Function), expect.any(Function), expect.any(AbortSignal), 300_000, '6-0');
    expect(res.chunks[0]).toMatch(/^id: 5\nevent: run\.log\n/);
    expect(JSON.parse(res.chunks[1].split('data: ')[1])).toEqual({ type: 'llm.chunk', data: { content: 'hi' }, timestamp: 't', pos: '7-0' });
  });

  it.each([
    [{ after: '-1' }],
    [{ after: '0', live: 'later' }],
  ])('refuses a malformed position %p before looking the run up', async (query) => {
    const { helper, runtime } = build();
    await expect(helper.handleAgentRequest(agent(), org(), req('/acme/support/runs/run-1/stream', query as any), fakeRes(), {})).rejects.toMatchObject({
      status: 400,
    });
    expect(runtime.getRun).not.toHaveBeenCalled();
  });
});
