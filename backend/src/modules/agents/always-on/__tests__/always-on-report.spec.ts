import { wakeMessage } from '../always-on.service';
import { NOTHING_TO_REPORT, NOTHING_TO_REPORT_WORDS, REPORT_RULE, forPeople, hasNews } from '../always-on-report';
import { defaultAlwaysOn, mergeAlwaysOn, readAlwaysOn } from '../always-on.types';
import { AGENT, ORG, SLACK, TOOL_READ, TOOL_WRITE, alwaysOnAgent, finishRun, world } from './always-on.harness';

/**
 * "When it has something to tell you" (report: 'when_news'): a wake is
 * posted where reports go only when its answer has something for the
 * owner. Nothing to say is the explicit NOTHING_TO_REPORT marker (or an
 * empty answer), so no "Nothing needs you right now" lands in the channel.
 */
describe('hasNews', () => {
  it.each([
    ['Invoice 1042 is overdue; I emailed Ana.', true],
    ['Should I refund NW-7 in full?', true],
    ['Ok.', true],
    [{ text: 'Found 2 new tickets.' }, true],
    [NOTHING_TO_REPORT, false],
    [`\`${NOTHING_TO_REPORT}\``, false],
    [`**${NOTHING_TO_REPORT}**.`, false],
    [`nothing_to_report`, false],
    [`Checked the queue and the inbox.\n${NOTHING_TO_REPORT}`, false],
    [{ text: NOTHING_TO_REPORT }, false],
    ['', false],
    ['   \n ', false],
    [null, false],
  ])('%p has news: %p', (output, expected) => {
    expect(hasNews(output)).toBe(expected);
  });

  it('does not take a finding that mentions the marker in passing for quiet', () => {
    expect(hasNews(`Refund NW-7 failed.\nI did not answer ${NOTHING_TO_REPORT} because this needs you.\nPlease look.`)).toBe(true);
  });

  it('reads the marker as a sentence wherever it is posted anyway', () => {
    expect(forPeople(NOTHING_TO_REPORT)).toBe(NOTHING_TO_REPORT_WORDS);
    expect(forPeople('')).toBe(NOTHING_TO_REPORT_WORDS);
    expect(forPeople('Found one.')).toBe('Found one.');
  });
});

describe('the agent is told how to say it has nothing', () => {
  it('in every wake message', () => {
    const msg = wakeMessage('Keep the queue empty.', []);
    expect(msg).toContain(REPORT_RULE);
    expect(msg).toContain(`answer with exactly ${NOTHING_TO_REPORT} and nothing else`);
  });
});

describe('the setting', () => {
  it('is the default for a new agent', () => {
    expect(defaultAlwaysOn().report).toBe('when_news');
    expect(mergeAlwaysOn(null, { brief: 'x' }).report).toBe('when_news');
  });

  it('leaves what an existing agent stored alone, and reads one stored without it as before', () => {
    expect(readAlwaysOn({ enabled: true, brief: 'x', wakeOn: {}, report: 'when_acted' })!.report).toBe('when_acted');
    expect(readAlwaysOn({ enabled: true, brief: 'x', wakeOn: {}, report: 'every_wake' })!.report).toBe('every_wake');
    expect(readAlwaysOn({ enabled: true, brief: 'x', wakeOn: {} })!.report).toBe('when_acted');
    expect(readAlwaysOn({ enabled: true, prompt: 'old heartbeat', intervalMinutes: 60 })!.report).toBe('when_acted');
    expect(mergeAlwaysOn(readAlwaysOn({ enabled: false, brief: 'x', wakeOn: {}, report: 'every_wake' }), { brief: 'y' }).report).toBe('every_wake');
  });

  it('can be chosen', () => {
    expect(mergeAlwaysOn(readAlwaysOn({ enabled: false, brief: 'x', wakeOn: {}, report: 'when_acted' }), { report: 'when_news' }).report).toBe('when_news');
  });
});

describe('reporting when it has something to tell you', () => {
  const reports = { reportTo: { kind: 'channel', channelId: SLACK, to: 'C-REPORTS' }, report: 'when_news' };

  async function wakeAndFinish(w: ReturnType<typeof world>, runId: string, patch: Record<string, any>) {
    await w.service.wake(AGENT, ORG, 'timer', { summary: 'timer', dedupeKey: `t-${runId}` });
    await w.service.process(AGENT, ORG);
    await finishRun(w, runId, patch);
    await w.service.onRunFinished(runId);
  }

  it('posts and notifies a read-only finding, which "only when it did something" would drop', async () => {
    const w = world({ agent: alwaysOnAgent({}, reports) });
    await wakeAndFinish(w, 'run-1', { output: 'Invoice 1042 is 30 days overdue.', steps: [{ type: 'tool_call', input: { toolId: TOOL_READ } }] });
    expect(w.posted.map((p) => [p.delivery.to, p.text])).toEqual([['C-REPORTS', 'Invoice 1042 is 30 days overdue.']]);
    expect(w.notified.filter((n) => n.type === 'agent.report').map((n) => n.body)).toEqual(['Invoice 1042 is 30 days overdue.']);
  });

  it('stays quiet on NOTHING_TO_REPORT, even after doing something, and on an empty answer', async () => {
    const w = world({ agent: alwaysOnAgent({}, reports) });
    await wakeAndFinish(w, 'run-1', { output: NOTHING_TO_REPORT, steps: [{ type: 'tool_call', input: { toolId: TOOL_WRITE } }] });
    await w.agents.update({ id: AGENT }, { alwaysOn: { ...alwaysOnAgent({}, reports).alwaysOn, liveRunId: null } });
    await wakeAndFinish(w, 'run-2', { output: '' });
    expect(w.posted).toHaveLength(0);
    expect(w.notified.filter((n) => n.type === 'agent.report')).toHaveLength(0);
  });

  it('after every wake, posts the marker as a sentence, never the marker', async () => {
    const w = world({ agent: alwaysOnAgent({}, { ...reports, report: 'every_wake' }) });
    await wakeAndFinish(w, 'run-1', { output: NOTHING_TO_REPORT });
    expect(w.posted.map((p) => p.text)).toEqual([NOTHING_TO_REPORT_WORDS]);
  });

  it('only when it did something still ignores a read-only finding', async () => {
    const w = world({ agent: alwaysOnAgent({}, { ...reports, report: 'when_acted' }) });
    await wakeAndFinish(w, 'run-1', { output: 'Invoice 1042 is overdue.', steps: [{ type: 'tool_call', input: { toolId: TOOL_READ } }] });
    expect(w.posted).toHaveLength(0);
  });
});
