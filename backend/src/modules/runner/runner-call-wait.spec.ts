import { readFileSync } from 'fs';
import { join } from 'path';

import { MAX_RUNNER_CALL_WAIT_MS, runnerCallWait } from './runner-capabilities';

/**
 * A runner call is waited for as long as the command was allowed to run.
 * shell.exec takes its own hard timeout; a coding assistant started with
 * ten minutes used to be reported, after 30 seconds, as a runner that did
 * not respond.
 */
describe('runnerCallWait', () => {
  it("waits for a command's own timeout, plus time for its answer", () => {
    expect(runnerCallWait(undefined, { command: 'claude -p "..."', timeoutMs: 600_000 })).toBe(610_000);
  });

  it("the tool's own timeout wins", () => {
    expect(runnerCallWait(45_000, { timeoutMs: 600_000 })).toBe(45_000);
  });

  it('without either, leaves it to the dispatch default', () => {
    expect(runnerCallWait(undefined, { command: 'ls' })).toBeUndefined();
    expect(runnerCallWait(undefined, { timeoutMs: -1 })).toBeUndefined();
    expect(runnerCallWait(undefined, { timeoutMs: 'soon' })).toBeUndefined();
    expect(runnerCallWait(undefined, undefined)).toBeUndefined();
  });

  it('never waits longer than an hour and its grace', () => {
    expect(runnerCallWait(undefined, { timeoutMs: 10 * MAX_RUNNER_CALL_WAIT_MS })).toBe(MAX_RUNNER_CALL_WAIT_MS + 10_000);
  });

  it('is what the tool executor waits with when it dispatches a runner call', () => {
    const source = readFileSync(join(__dirname, '../tools/tool-executor.service.ts'), 'utf8');
    expect(source).toMatch(/timeoutMs: runnerCallWait\(tool\.configuration\?\.timeout, callParams\)/);
  });
});
