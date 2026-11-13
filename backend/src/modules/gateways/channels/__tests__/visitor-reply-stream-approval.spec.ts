import { approvalEnding, finishedReason, streamVisitorReply } from '../visitor-reply-stream';

/**
 * A web chat visitor whose reply waits on a person approving a step used to
 * see "thinking" dots for as long as the approval took (hours, up to its
 * expiry), and then nothing: a rejection or an expiry cancelled the run
 * without a word on its stream. The stream now says the run is waiting,
 * that it is working again once approved, and why it ended otherwise.
 */
describe('visitor reply stream: a step waiting for approval', () => {
  function stream(run: { id: string; status?: string; error?: string | null }, events: Array<{ type: string; data?: any }>) {
    const chunks: string[] = [];
    const res: any = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn((c: string) => chunks.push(c)), end: jest.fn() };
    const req: any = { headers: {}, on: jest.fn() };
    const runtime = {
      subscribeRunEvents: jest.fn(async (_id: string, onEvent: (e: any, id?: string) => void) => {
        events.forEach((event, i) => onEvent(event, `1-${i}`));
      }),
    };
    return streamVisitorReply({ req, res, runtime: runtime as any, run, resumeFrom: null }).then(() =>
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
});
