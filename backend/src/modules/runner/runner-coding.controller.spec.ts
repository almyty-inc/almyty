import { EventEmitter } from 'events';
import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';

import { RunnerController } from './runner.controller';
import { RunnerCallError, RUNNER_CALL_ERRORS } from './runner-call.service';

/**
 * Chat-to-runner coding bridge endpoints. Authz scope is the ORGANIZATION
 * (getUsable: 404 for unknown, cross-org or unusable), dispatch rides the same
 * RunnerCallService envelope as agent.*, and the per-session SSE endpoint
 * relays coding.output / coding.exit events from CodingRelayService.
 */
describe('RunnerController coding.* endpoints', () => {
  const req = { user: { id: 'u1', currentOrganizationId: 'org1' } };
  const SID = 'cs_0d5f8a1e-1111-2222-3333-444455556666';

  function make(over: {
    getUsable?: jest.Mock;
    dispatch?: jest.Mock;
    subscribe?: jest.Mock;
  } = {}) {
    const service = {
      getUsable: over.getUsable ?? jest.fn().mockResolvedValue({ id: 'r1', organizationId: 'org1' }),
    } as any;
    const calls = {
      dispatch: over.dispatch ?? jest.fn().mockResolvedValue({ ok: true, result: { x: 1 } }),
    } as any;
    const relay = {
      subscribe: over.subscribe ?? jest.fn().mockReturnValue(() => {}),
    } as any;
    return { ctrl: new RunnerController(service, calls, relay), service, calls, relay };
  }

  function fakeRes() {
    const res = new EventEmitter() as any;
    res.headers = {} as Record<string, string>;
    res.writes = [] as string[];
    res.destroyed = false;
    res.ended = false;
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
    res.flushHeaders = jest.fn();
    res.write = (frame: string) => { res.writes.push(frame); return true; };
    res.end = () => { res.ended = true; };
    return res;
  }

  it('coding agents list scopes to the org then dispatches coding.list', async () => {
    const { ctrl, service, calls } = make();
    const out = await ctrl.codingAgents(req, 'r1');
    expect(service.getUsable).toHaveBeenCalledWith('r1', 'u1', 'org1');
    expect(calls.dispatch).toHaveBeenCalledWith('r1', 'coding.list', {}, undefined, { callerUserId: 'u1' });
    expect(out).toEqual({ success: true, data: { x: 1 } });
  });

  it('coding start dispatches coding.start with the task params', async () => {
    const dispatch = jest.fn().mockResolvedValue({ ok: true, result: { sessionId: SID } });
    const { ctrl } = make({ dispatch });
    const out = await ctrl.codingStart(req, 'r1', {
      agent: 'claude',
      task: 'fix the login bug',
      cwd: '/home/me',
    } as any);
    expect(dispatch).toHaveBeenCalledWith(
      'r1',
      'coding.start',
      { agent: 'claude', task: 'fix the login bug', cwd: '/home/me' },
      undefined, { callerUserId: 'u1' },
    );
    expect(out).toEqual({ success: true, data: { sessionId: SID } });
  });

  it('coding input and stop route to the session', async () => {
    const dispatch = jest.fn().mockResolvedValue({ ok: true, result: {} });
    const { ctrl } = make({ dispatch });
    await ctrl.codingInput(req, 'r1', SID, { data: 'yes' } as any);
    expect(dispatch).toHaveBeenCalledWith('r1', 'coding.input', { sessionId: SID, data: 'yes' }, undefined, { callerUserId: 'u1' });
    await ctrl.codingStop(req, 'r1', SID, { force: true } as any);
    expect(dispatch).toHaveBeenCalledWith('r1', 'coding.stop', { sessionId: SID, force: true }, undefined, { callerUserId: 'u1' });
  });

  it('rejects malformed session ids before dispatching', async () => {
    const dispatch = jest.fn();
    const { ctrl } = make({ dispatch });
    await expect(ctrl.codingStatus(req, 'r1', '../etc/passwd')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cross-org access is refused with the not-found answer and never dispatched', async () => {
    const getUsable = jest.fn().mockRejectedValue(new NotFoundException('runner not found'));
    const dispatch = jest.fn();
    const { ctrl } = make({ getUsable, dispatch });
    await expect(ctrl.codingStart(req, 'r1', { agent: 'claude', task: 'x' } as any))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('unknown runner is 404', async () => {
    const getUsable = jest.fn().mockRejectedValue(new NotFoundException('runner not found'));
    const { ctrl } = make({ getUsable });
    await expect(ctrl.codingAgents(req, 'r1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires organization context', async () => {
    const { ctrl } = make();
    await expect(ctrl.codingAgents({ user: { id: 'u1' } }, 'r1')).rejects.toBeInstanceOf(HttpException);
  });

  it('offline runner maps to 503 like the agent surface', async () => {
    const dispatch = jest.fn().mockRejectedValue(
      new RunnerCallError(RUNNER_CALL_ERRORS.RUNNER_OFFLINE, 'offline'),
    );
    const { ctrl } = make({ dispatch });
    await expect(ctrl.codingStart(req, 'r1', { agent: 'claude', task: 'x' } as any))
      .rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
  });

  describe('SSE event stream', () => {
    it('streams matching coding.output frames and ends on coding.exit', async () => {
      let listener: ((event: any) => void) | undefined;
      const unsubscribe = jest.fn();
      const subscribe = jest.fn().mockImplementation((_runnerId: string, l: any) => {
        listener = l;
        return unsubscribe;
      });
      const { ctrl } = make({ subscribe });
      const res = fakeRes();

      await ctrl.codingEvents(req, 'r1', SID, res);
      expect(subscribe).toHaveBeenCalledWith('r1', expect.any(Function));
      expect(res.headers['Content-Type']).toBe('text/event-stream');

      listener!({ kind: 'coding.output', sessionId: SID, data: 'hello\n', seq: 1 });
      listener!({ kind: 'coding.output', sessionId: 'cs_other', data: 'noise\n', seq: 1 });
      listener!({ kind: 'coding.exit', sessionId: SID, exitCode: 0, signal: null });

      expect(res.writes).toHaveLength(2); // other-session event filtered out
      expect(res.writes[0]).toContain('event: coding.output');
      expect(res.writes[0]).toContain('"data":"hello\\n"');
      expect(res.writes[1]).toContain('event: coding.exit');
      expect(res.ended).toBe(true);
      expect(unsubscribe).toHaveBeenCalled();
    });

    it('unsubscribes when the client disconnects', async () => {
      const unsubscribe = jest.fn();
      const subscribe = jest.fn().mockReturnValue(unsubscribe);
      const { ctrl } = make({ subscribe });
      const res = fakeRes();

      await ctrl.codingEvents(req, 'r1', SID, res);
      res.emit('close');
      expect(unsubscribe).toHaveBeenCalled();
    });

    it('org gate applies to the stream too', async () => {
      const getUsable = jest.fn().mockRejectedValue(new ForbiddenException('nope'));
      const subscribe = jest.fn();
      const { ctrl } = make({ getUsable, subscribe });
      await expect(ctrl.codingEvents(req, 'r1', SID, fakeRes()))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(subscribe).not.toHaveBeenCalled();
    });
  });
});
