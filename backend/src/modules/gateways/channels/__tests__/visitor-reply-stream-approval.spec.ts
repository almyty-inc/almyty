import { approvalEnding, finishedReason, streamVisitorReply } from '../visitor-reply-stream';

/**
 * A web chat visitor whose reply waits on a person approving a step used to
 * see "thinking" dots for as long as the approval took (hours, up to its
 * expiry), and then nothing: a rejection or an expiry cancelled the run
 * without a word on its stream. The stream now says the run is waiting,
 * that it is working again once approved, and why it ended otherwise.
 */
describe('visitor reply stream: a step waiting for approval', () => {
  function stream(
    run: { id: string; status?: string; error?: string | null },
    events: Array<{ type: string; data?: any }>,
    resumeFrom: { event: string; frame: number } | null = null,
  ) {
    const chunks: string[] = [];
    const res: any = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn((c: string) => chunks.push(c)), end: jest.fn() };
    const req: any = { headers: {}, on: jest.fn() };
    const runtime = {
      subscribeRunEvents: jest.fn(async (_id: string, onEvent: (e: any, id?: string) => void) => {
        events.forEach((event, i) => onEvent(event, `1-${i}`));
      }),
    };
    return streamVisitorReply({ req, res, runtime: runtime as any, run, resumeFrom }).then(() =>
      chunks
        .join('')
        .split('\n\n')
        .filter((f) => f.startsWith('event:') || f.includes('\nevent:'))
        .map((f) => {
          const name = /event: (\S+)/.exec(f)![1];
          const data = JSON.parse(/data: (.*)/.exec(f)![1]);
          return { name, data };
        }),
    );
  }

  it('says the run is waiting on a person, then that it is working again', async () => {
    const frames = await stream({ id: 'run-1', status: 'running' }, [
      { type: 'step.completed', data: { step: 1, status: 'waiting_approval' } },
      { type: 'approval.decided', data: { status: 'approved', resumed: true } },
      { type: 'llm.started', data: { step: 2, answer: true } },
      { type: 'llm.chunk', data: { step: 2, content: 'Done.' } },
      { type: 'run.completed', data: {} },
    ]);
    expect(frames.map((f) => f.name)).toEqual(['waiting', 'resumed', 'token', 'done']);
    expect(frames[0].data).toEqual({ for: 'approval' });
    expect(frames[3].data).toEqual({ reason: 'run.completed' });
  });

  it('ends with the reason when the approval is turned down or expires', async () => {
    const rejected = await stream({ id: 'run-1', status: 'running' }, [
      { type: 'step.completed', data: { step: 1, status: 'waiting_approval' } },
      { type: 'run.cancelled', data: { error: 'approval rejected: no', reasonCode: 'APPROVAL_REJECTED' } },
    ]);
    expect(rejected.map((f) => [f.name, f.data.reason])).toEqual([['waiting', undefined], ['done', 'approval.rejected']]);

    const expired = await stream({ id: 'run-1', status: 'running' }, [
      { type: 'run.cancelled', data: { error: 'approval expired', reasonCode: 'APPROVAL_EXPIRED' } },
    ]);
    expect(expired).toEqual([{ name: 'done', data: { reason: 'approval.expired' } }]);
  });

  it('says so at once when the page opens on a run already waiting', async () => {
    const frames = await stream({ id: 'run-1', status: 'waiting_approval' }, []);
    expect(frames[0]).toEqual({ name: 'waiting', data: { for: 'approval' } });
  });

  it('gives a finished run the approval reason it was cancelled with', async () => {
    expect(await stream({ id: 'run-1', status: 'cancelled', error: 'approval expired' }, [])).toEqual([
      { name: 'done', data: { reason: 'approval.expired' } },
    ]);
    expect(finishedReason({ status: 'cancelled', error: 'approval rejected: too large' })).toBe('approval.rejected');
    // A cancel by hand stays a cancel.
    expect(finishedReason({ status: 'cancelled', error: null })).toBe('run.cancelled');
    expect(approvalEnding({})).toBeUndefined();
  });

  /*
   * Whatever order the approval, the run and the visitor's connection come
   * in, the visitor ends on the answer: the stream reads the run's events
   * from their start, so there is no window between "decided" and
   * "subscribed" for an event to fall into. Gate 261116145643 failed on J9
   * with the page still waiting; the logs showed the run itself waiting
   * again, on a second held call (below), not a lost event.
   */
  const approvedTwice = [
    { type: 'step.completed', data: { step: 1, status: 'waiting_approval' } },
    { type: 'approval.decided', data: { status: 'approved', resumed: true } },
    // The approved call failed, and the model tried again with other
    // arguments: a new call, held for its own approval.
    { type: 'step.completed', data: { step: 2, status: 'waiting_approval' } },
    { type: 'approval.decided', data: { status: 'approved', resumed: true } },
    { type: 'llm.started', data: { step: 3, answer: true } },
    { type: 'llm.chunk', data: { step: 3, content: 'It will be ' } },
    { type: 'llm.chunk', data: { step: 3, content: '7.4 °C.' } },
    { type: 'run.completed', data: {} },
  ];

  it('waits again when the run holds a second step, and answers once that is approved', async () => {
    const frames = await stream({ id: 'run-1', status: 'running' }, approvedTwice);
    expect(frames.map((f) => f.name)).toEqual(['waiting', 'resumed', 'waiting', 'resumed', 'token', 'token', 'done']);
    expect(frames.filter((f) => f.name === 'token').map((f) => f.data.content).join('')).toBe('It will be 7.4 °C.');
  });

  it('a visitor who opens the stream only after the run was held a second time is told it waits', async () => {
    // Still held when the stream reaches its time limit: no `done`, so the page keeps waiting and reconnects.
    const frames = await stream({ id: 'run-1', status: 'waiting_approval' }, [...approvedTwice.slice(0, 3), { type: 'stream.timeout' }]);
    expect(frames.map((f) => f.name)).toEqual(['waiting', 'waiting', 'resumed', 'waiting']);
  });

  it('a visitor who opens the stream after the approval was decided still gets the answer', async () => {
    const frames = await stream({ id: 'run-1', status: 'running' }, approvedTwice);
    expect(frames[frames.length - 1]).toEqual({ name: 'done', data: { reason: 'run.completed' } });
    expect(frames.some((f) => f.name === 'token')).toBe(true);
  });

  it('a visitor who reconnects mid-answer gets the rest of it, once, and the end', async () => {
    // The first chunk is event 1-5; the visitor had its frame.
    const frames = await stream({ id: 'run-1', status: 'running' }, approvedTwice, { event: '1-5', frame: 0 });
    const tokens = frames.filter((f) => f.name === 'token').map((f) => f.data.content);
    expect(tokens).toEqual(['7.4 °C.']);
    expect(frames[frames.length - 1]).toEqual({ name: 'done', data: { reason: 'run.completed' } });
    // The last word on waiting is "resumed": the page does not stay on the notice.
    const states = frames.filter((f) => f.name === 'waiting' || f.name === 'resumed');
    expect(states[states.length - 1].name).toBe('resumed');
  });
});
