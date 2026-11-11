import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { runsWithEvents } from '../../../test/fake-run-events';
import { fakeRedisStreams } from '../../../test/fake-redis-streams';
import { AgentRuntimeEventsHelper } from '../agent-runtime-events.helper';
import { AgentRuntimeService } from '../agent-runtime.service';
import { AgentRunsController } from '../agent-runs.controller';
import { writeRun } from '../run-event-writer';
import { carriesArguments, eventsForViewers, runForViewers, runLogView } from '../run-log-privacy';
import { StepJournal } from '../run-resume';
import { piiFilterOn } from './pii-filter-on';

/**
 * Tool-call arguments in a run's log keep their real values for the step
 * that resumes from them (StepJournal), and are shown with personal data
 * hidden everywhere the log is read out: the run streams (dashboard and
 * API-key routes, through AgentRuntimeEventsHelper.subscribeRunLog), the
 * run view, and whatever reads the log out later (run-log-privacy.ts). The
 * hiding is the organization's own PII filter.
 */
const EMAIL = 'ana.lopez@example.com';
const hide = piiFilterOn();
const hideAll = (values: any[]) => hide(values, { organizationId: 'org-1' });

const event = (seq: number, type: string, payload: any) => ({ runId: 'run-1', seq, type, step: 0, payload, createdAt: new Date('2026-11-07T10:00:00Z') });

describe('run-log-privacy: the arguments in logged events', () => {
  const page = () => [
    event(1, 'model_answered', {
      messageCount: 2,
      response: { cost: 0.01, message: { role: 'assistant', content: '', toolCalls: [{ id: 'tc-1', name: 'notify_customer', parameters: { to: EMAIL, text: 'hi' } }] } },
    }),
    event(2, 'tool_started', { callIndex: 0, key: 'run-1:0:0', tool: 'notify_customer', parameters: { to: EMAIL } }),
    event(3, 'memory_changed', { set: { gatedToolCalls: [{ toolCallId: 'tc-2', toolId: 't-2', toolName: 'refund', approvalId: 'a-1', parameters: { email: EMAIL } }] } }),
    event(4, 'tool_call', { index: 1, callIndex: 0, step: { type: 'tool_call', input: { tool: 'notify_customer', toolId: 't-1', parameters: { to: EMAIL } } } }),
    event(5, 'step_committed', { status: 'running', currentStep: 1 }),
    event(6, 'tool_finished', {
      callIndex: 1,
      key: 'run-1:0:1',
      steps: [{ type: 'tool_call', input: { tool: 'refund', parameters: { email: EMAIL } } }],
      local: { gated: [{ toolCallId: 'tc-3', approvalId: 'a-3', parameters: { email: EMAIL } }] },
    }),
  ];

  it('hides personal data in every argument, and touches nothing else', async () => {
    const original = page();
    const shown = await eventsForViewers(original, hideAll);
    const text = JSON.stringify(shown);
    expect(text).not.toContain(EMAIL);
    expect(shown[0].payload.response.message.toolCalls[0]).toMatchObject({ id: 'tc-1', name: 'notify_customer', parameters: { text: 'hi' } });
    expect(shown[0].payload.response.message.toolCalls[0].parameters.to).toMatch(/\*+\.com$/);
    expect(shown[1].payload).toMatchObject({ callIndex: 0, key: 'run-1:0:0', tool: 'notify_customer' });
    expect(shown[2].payload.set.gatedToolCalls[0]).toMatchObject({ toolCallId: 'tc-2', approvalId: 'a-1' });
    expect(shown[3].payload.step.input).toMatchObject({ tool: 'notify_customer', toolId: 't-1' });
    expect(shown[4]).toEqual(original[4]);
    expect(shown.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(shown[5].payload).toMatchObject({ callIndex: 1, key: 'run-1:0:1', local: { gated: [{ approvalId: 'a-3' }] } });
    // The events handed in keep the real values.
    expect(original[1].payload.parameters.to).toBe(EMAIL);
    expect(original[0].payload.response.message.toolCalls[0].parameters.to).toBe(EMAIL);
  });

  it('a page with no arguments goes out as it is, without filtering', async () => {
    const quiet = [event(1, 'step_committed', { status: 'running' }), event(2, 'status_changed', { from: 'running', to: 'waiting_approval' })];
    const spy = jest.fn(hideAll);
    expect(carriesArguments(quiet)).toBe(false);
    expect(await eventsForViewers(quiet, spy)).toBe(quiet);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a filter that fails hides the arguments altogether', async () => {
    const shown = await eventsForViewers(page(), async () => {
      throw new Error('filter down');
    });
    expect(shown[1].payload.parameters).toBe('[hidden]');
    expect(JSON.stringify(shown)).not.toContain(EMAIL);
  });

  it('the stream view filters under the run’s organization, and looks the run up only for a page with arguments', async () => {
    const ownerOf = jest.fn(async () => ({ organizationId: 'org-1', userId: 'u-1' }));
    const filter = jest.fn((data: any, options: any) => hide(data, options));
    const view = runLogView(ownerOf, filter);
    await view('run-1', [event(1, 'step_committed', {})]);
    expect(ownerOf).not.toHaveBeenCalled();
    const shown = await view('run-1', page());
    expect(ownerOf).toHaveBeenCalledWith('run-1');
    expect(filter).toHaveBeenCalledWith(expect.any(Array), { organizationId: 'org-1', userId: 'u-1' });
    expect(JSON.stringify(shown)).not.toContain(EMAIL);
    // A run that cannot be found: nothing of its arguments is shown.
    const gone = await runLogView(async () => null, filter)('run-1', page());
    expect(gone[1].payload.parameters).toBe('[hidden]');
  });
});

describe('run-log-privacy: the run view', () => {
  it('hides the arguments of held calls and steps, keeps the row as it is', async () => {
    const run = Object.assign(new AgentRun(), {
      id: 'run-1',
      organizationId: 'org-1',
      workingMemory: {
        gatedToolCalls: [{ toolCallId: 'tc-1', toolId: 't-1', toolName: 'refund', approvalId: 'a-1', parameters: { email: EMAIL, amount: 40 } }],
        unknownOutcomeCalls: [{ toolCallId: 'tc-2', toolId: 't-2', toolName: 'notify_customer', approvalId: 'a-2', attempts: [] }],
        notes: 'kept',
      },
      steps: [{ type: 'tool_call', input: { tool: 'refund', parameters: { email: EMAIL } }, output: { ok: true } }],
    });
    const shown = await runForViewers(run, hideAll);
    expect(shown).toBeInstanceOf(AgentRun);
    expect(JSON.stringify(shown)).not.toContain(EMAIL);
    expect(shown.workingMemory.gatedToolCalls[0]).toMatchObject({ approvalId: 'a-1', parameters: { amount: 40 } });
    expect(shown.workingMemory.notes).toBe('kept');
    expect(run.workingMemory.gatedToolCalls[0].parameters.email).toBe(EMAIL);
  });

  it('GET /agents/:id/runs/:runId answers with the run as the viewer sees it', async () => {
    const runtime = {
      getRun: jest.fn(async () => ({ id: 'run-1', workingMemory: { gatedToolCalls: [{ parameters: { email: EMAIL } }] } })),
      getRunForViewer: jest.fn(async () => ({ id: 'run-1', workingMemory: { gatedToolCalls: [{ parameters: { email: '****mple.com' } }] } })),
    };
    const controller = new AgentRunsController(runtime as any);
    const out: any = await controller.getRun('agent-1', 'run-1', { user: { currentOrganizationId: 'org-1' } });
    expect(runtime.getRunForViewer).toHaveBeenCalledWith('run-1', 'org-1', 'agent-1');
    expect(JSON.stringify(out)).not.toContain(EMAIL);
  });

  it('getRunForViewer filters the run under its organization', async () => {
    const row = { id: 'run-1', organizationId: 'org-9', userId: 'u-9', workingMemory: { wakingToolCalls: [{ parameters: { to: EMAIL } }] }, steps: [] };
    const filter = jest.fn((data: any, options: any) => hide(data, options));
    const self = { getRun: jest.fn(async () => row), toolExecutorService: { hidePersonalData: filter } };
    const shown = await AgentRuntimeService.prototype.getRunForViewer.call(self, 'run-1', 'org-9', 'agent-1');
    expect(self.getRun).toHaveBeenCalledWith('run-1', 'org-9', 'agent-1');
    expect(filter).toHaveBeenCalledWith(expect.any(Array), { organizationId: 'org-9', userId: 'u-9' });
    expect(JSON.stringify(shown)).not.toContain(EMAIL);
  });
});

describe('run-log-privacy: a live run view of the log', () => {
  let helper: AgentRuntimeEventsHelper;
  let runs: ReturnType<typeof runsWithEvents>;

  beforeEach(() => {
    runs = runsWithEvents([
      { id: 'run-1', organizationId: 'org-1', userId: null, status: AgentRunStatus.RUNNING, currentStep: 0, headSeq: 0, workingMemory: {}, metadata: {}, steps: [] } as any,
    ]);
    helper = new AgentRuntimeEventsHelper(runs as any, fakeRedisStreams());
    helper.logIdleReadMs = 60_000;
    helper.logEndGraceMs = 50;
    helper.onModuleInit();
  });
  afterEach(() => helper.onModuleDestroy());

  const logCall = async () => {
    await writeRun(runs as any, { id: 'run-1' }, { currentStep: 0 });
    await writeRun(runs as any, { id: 'run-1' }, {}, [{ type: 'tool_started', step: 0, payload: { callIndex: 0, key: 'run-1:0:0', tool: 'notify_customer', parameters: { to: EMAIL } } }], { progress: true });
    await writeRun(runs as any, { id: 'run-1' }, { status: AgentRunStatus.COMPLETED, output: 'done' });
  };
  const watch = async () => {
    const seen: any[] = [];
    await helper.subscribeRunLog('run-1', 0, (e) => seen.push(e), () => undefined, undefined, 2_000);
    return seen;
  };

  it('sends the log with the arguments filtered by the view the runtime sets, while resume reads the real ones', async () => {
    await logCall();
    const ownerOf = jest.fn(async (id: string) => runs.row(id) as any);
    helper.setRunLogView(runLogView(ownerOf, (data, options) => hide(data, options)));
    const seen = await watch();
    const started = seen.find((e) => e.type === 'tool_started');
    expect(started.payload).toMatchObject({ callIndex: 0, key: 'run-1:0:0', tool: 'notify_customer' });
    expect(started.payload.parameters.to).toMatch(/\*+\.com$/);
    expect(JSON.stringify(seen)).not.toContain(EMAIL);
    expect(seen.map((e) => e.seq)).toEqual(runs.events.rows('run-1').map((e: any) => e.seq));
    // Stored, and read by a resuming step, as they were.
    expect(runs.events.rows('run-1').find((e: any) => e.type === 'tool_started').payload.parameters.to).toBe(EMAIL);
    const journal = await StepJournal.read(runs as any, Object.assign(new AgentRun(), runs.row('run-1'), { currentStep: 0 }));
    expect(journal.wasStarted(0)).toBe(true);
  });

  it('before the runtime sets a view, no argument goes out at all', async () => {
    await logCall();
    const seen = await watch();
    expect(seen.find((e) => e.type === 'tool_started').payload.parameters).toBe('[hidden]');
  });

  it('the runtime service sets the view on start, filtering under the run’s organization', async () => {
    let view: any;
    const filter = jest.fn(async (data: any) => data.map(() => 'masked'));
    const self: any = {
      events: { setCleanupHook: jest.fn(), setRunLogView: jest.fn((v: any) => (view = v)) },
      approvals: { on: jest.fn() },
      misc: {},
      runRepository: { findOne: jest.fn(async () => ({ id: 'run-1', organizationId: 'org-7', userId: 'u-7' })) },
      toolExecutorService: { hidePersonalData: filter },
    };
    AgentRuntimeService.prototype.onModuleInit.call(self);
    expect(self.events.setRunLogView).toHaveBeenCalled();
    const shown = await view('run-1', [event(1, 'tool_started', { callIndex: 0, parameters: { to: EMAIL } })]);
    expect(filter).toHaveBeenCalledWith([{ to: EMAIL }], { organizationId: 'org-7', userId: 'u-7' });
    expect(shown[0].payload.parameters).toBe('masked');
  });
});

describe('run-log-privacy: hidden whatever the organization set', () => {
  /** An organization whose PII filter is off: hidePersonalData hands every value back as it is. */
  const filterOff = async <T>(data: T) => data;

  it('the stream view hides personal data even when the organization’s filter is off', async () => {
    const view = runLogView(async () => ({ organizationId: 'org-off', userId: null }), filterOff);
    const shown = await view('run-1', [
      event(1, 'tool_started', { callIndex: 0, key: 'run-1:0:0', tool: 'notify_customer', parameters: { to: EMAIL, phone: '555-123-4567' } }),
      event(2, 'model_answered', { response: { message: { toolCalls: [{ id: 'tc-1', name: 'notify_customer', parameters: { to: EMAIL } }] } } }),
    ]);
    expect(JSON.stringify(shown)).not.toContain(EMAIL);
    expect(JSON.stringify(shown)).not.toContain('555-123-4567');
    expect(shown[0].payload).toMatchObject({ callIndex: 0, key: 'run-1:0:0', tool: 'notify_customer' });
  });

  it('the run view hides personal data even when the organization’s filter is off', async () => {
    const row = { id: 'run-1', organizationId: 'org-off', userId: null, workingMemory: { gatedToolCalls: [{ approvalId: 'a-1', parameters: { email: EMAIL } }] }, steps: [] };
    const self = { getRun: jest.fn(async () => row), toolExecutorService: { hidePersonalData: jest.fn(filterOff) } };
    const shown = await AgentRuntimeService.prototype.getRunForViewer.call(self, 'run-1', 'org-off');
    expect(JSON.stringify(shown)).not.toContain(EMAIL);
    expect(shown.workingMemory.gatedToolCalls[0].approvalId).toBe('a-1');
  });

  it('the runtime service’s stream view hides personal data even when the organization’s filter is off', async () => {
    let view: any;
    const self: any = {
      events: { setCleanupHook: jest.fn(), setRunLogView: jest.fn((v: any) => (view = v)) },
      approvals: { on: jest.fn() },
      misc: {},
      runRepository: { findOne: jest.fn(async () => ({ id: 'run-1', organizationId: 'org-off', userId: null })) },
      toolExecutorService: { hidePersonalData: jest.fn(filterOff) },
    };
    AgentRuntimeService.prototype.onModuleInit.call(self);
    const shown = await view('run-1', [event(1, 'tool_started', { callIndex: 0, parameters: { to: EMAIL } })]);
    expect(JSON.stringify(shown)).not.toContain(EMAIL);
  });

  it('the result does not depend on the setting: filter off and filter on show the same', async () => {
    const page = () => [event(1, 'tool_started', { callIndex: 0, parameters: { to: EMAIL, card: '4111 1111 1111 1111' } })];
    const off = await runLogView(async () => ({ organizationId: 'org-off' }), filterOff)('run-1', page());
    const on = await runLogView(async () => ({ organizationId: 'org-on' }), (data, options) => hide(data, options))('run-1', page());
    expect(off[0].payload.parameters).toEqual(on[0].payload.parameters);
    expect(JSON.stringify(off)).not.toMatch(/ana\.lopez|4111 1111 1111 1111/);
  });
});

describe('run-log-privacy: every reader of the log', () => {
  const root = join(__dirname, '..', '..', '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__tests__' || name === 'test' || name === 'migrations' ? [] : files(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    });

  /**
   * Where the log's rows are read. Resume reads the real arguments
   * (run-resume.ts); the writer reads only the head under its lock; the
   * live view sends each page through the run log view. A new reader (an
   * export, a report) belongs on this list only once it goes through
   * eventsForViewers.
   */
  const READERS = new Set(['modules/agents/run-resume.ts', 'modules/agents/run-event-writer.ts', 'modules/agents/agent-runtime-events.helper.ts']);

  it('reads agent_run_events rows only where the arguments are either needed or hidden', () => {
    const reading = files(root)
      .filter((path) => /getRepository\(AgentRunEvent\)|Repository<AgentRunEvent>|from\(AgentRunEvent|FROM\s+"?agent_run_events/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path).split('\\').join('/'))
      .filter((path) => !path.startsWith('entities/'));
    expect(reading.filter((path) => !READERS.has(path))).toEqual([]);
  });

  it('the live view sends every page it reads through the view', () => {
    const source = readFileSync(join(root, 'modules/agents/agent-runtime-events.helper.ts'), 'utf8');
    expect(source).toMatch(/const shown = await this\.runLogView\(runId, rows\);/);
    expect(source).toMatch(/onLog\(shown\[i\] \?\? row\)/);
  });

  it('the API-key route shows a run as the viewer sees it', () => {
    const source = readFileSync(join(root, 'modules/gateways/unified-agent.helper.ts'), 'utf8');
    expect(source).toContain('this.runtimeService.getRunForViewer(runId, organization.id)');
    expect(source).not.toMatch(/const run = await this\.runtimeService\.getRun\(runId, organization\.id\);\s*return res\.json/);
  });

  it('a visitor’s reply stream reads only the runtime events, never the log', () => {
    const source = readFileSync(join(root, 'modules/gateways/channels/visitor-reply-stream.ts'), 'utf8');
    expect(source).not.toMatch(/subscribeRunLog|AgentRunEvent/);
  });
});
