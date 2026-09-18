import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * A streamed agent execution behind a gateway kept running after the client
 * had gone.
 *
 * The engine cancels cooperatively on `options.signal`, and
 * agent-execution.controller has always wired one to the request. This path
 * -- the one the chat REPL and every gateway client actually use -- passed
 * no signal at all. So Ctrl-C aborted the SSE on the client side and the
 * pipeline ran on to completion server-side: every event written into a
 * dead socket, every model call billed, and nobody left to read the answer.
 *
 * Source-reading because the defect is the absence of an argument, and a
 * behavioural test on the happy path passes identically without it.
 */
const helper = readFileSync(join(__dirname, '..', 'unified-agent.helper.ts'), 'utf8');

describe('a streamed execution stops when its client leaves', () => {
  it('passes a cancellation signal to the engine', () => {
    expect(helper).toContain('signal: abort.signal');
  });

  it('aborts on both close and aborted, since which one fires depends on how the client left', () => {
    expect(helper).toContain("res.req?.on('close', markClosed)");
    expect(helper).toContain("res.req?.on('aborted', markClosed)");
  });

  it('stops writing events into a socket nobody is reading', () => {
    // lastIndexOf on the execute call: the non-streaming invoke above has
    // one too, and indexOf would slice backwards into an empty string.
    const start = helper.indexOf('const onEvent = (event: StreamEvent)');
    const onEvent = helper.slice(start, helper.indexOf('};', start));
    expect(onEvent).toContain('if (!clientAlive) return;');
  });

  it('does not write a done frame to a closed connection', () => {
    const tail = helper.slice(helper.indexOf('signal: abort.signal'));
    const guard = tail.indexOf('if (!clientAlive) return;');
    const done = tail.indexOf('event: done');
    expect(guard).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(guard);
  });
});
