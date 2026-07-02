import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';

import { RunnerController } from './runner.controller';
import { RunnerCallError, RUNNER_CALL_ERRORS } from './runner-call.service';

/**
 * Coding-agent orchestration endpoints: ownership scoping + dispatch proxying.
 * getOne is the ownership gate (throws before any dispatch leaves the backend);
 * RunnerCallService.dispatch is the bridge to the runner.
 */
describe('RunnerController agent.* endpoints', () => {
  const req = { user: { id: 'u1', currentOrganizationId: 'org1' } };

  function make(over: {
    getOne?: jest.Mock;
    dispatch?: jest.Mock;
  } = {}) {
    const service = {
      getOne: over.getOne ?? jest.fn().mockResolvedValue({ id: 'r1' }),
    } as any;
    const calls = {
      dispatch: over.dispatch ?? jest.fn().mockResolvedValue({ ok: true, result: { x: 1 } }),
    } as any;
    const relay = { subscribe: jest.fn().mockReturnValue(() => {}) } as any;
    return { ctrl: new RunnerController(service, calls, relay), service, calls };
  }

  it('agent.list scopes ownership then dispatches agent.list', async () => {
    const { ctrl, service, calls } = make();
    const out = await ctrl.agentList(req, 'r1');
    expect(service.getOne).toHaveBeenCalledWith('r1', 'u1', 'org1');
    expect(calls.dispatch).toHaveBeenCalledWith('r1', 'agent.list', {}, undefined);
    expect(out).toEqual({ success: true, data: { x: 1 } });
  });

  it('agent.spawn peels workspaceId and forwards the rest as params', async () => {
    const dispatch = jest.fn().mockResolvedValue({ ok: true, result: { processId: 'proc_1' } });
    const { ctrl } = make({ dispatch });
    await ctrl.agentSpawn(req, 'r1', {
      platform: 'claude',
      workspaceId: 'ws-1',
      apiKey: 'sk',
      configDir: '/tmp/m',
    } as any);
    expect(dispatch).toHaveBeenCalledWith(
      'r1',
      'agent.spawn',
      { platform: 'claude', apiKey: 'sk', configDir: '/tmp/m' },
      'ws-1',
    );
  });

  it('agent.status forwards processId + platform, workspace routed separately', async () => {
    const dispatch = jest.fn().mockResolvedValue({ ok: true, result: { status: 'busy' } });
    const { ctrl } = make({ dispatch });
    const out = await ctrl.agentStatus(req, 'r1', {
      workspaceId: 'ws-1',
      processId: 'proc_1',
    } as any);
    expect(dispatch).toHaveBeenCalledWith('r1', 'agent.status', { processId: 'proc_1' }, 'ws-1');
    expect(out).toEqual({ success: true, data: { status: 'busy' } });
  });

  it('refuses when the caller does not own the runner (getOne throws)', async () => {
    const getOne = jest.fn().mockRejectedValue(new NotFoundException('runner not found'));
    const dispatch = jest.fn();
    const { ctrl } = make({ getOne, dispatch });
    await expect(ctrl.agentList(req, 'r1')).rejects.toBeInstanceOf(NotFoundException);
    expect(dispatch).not.toHaveBeenCalled(); // never dispatched
  });

  it('maps a runner-side error response to 502', async () => {
    const dispatch = jest.fn().mockResolvedValue({ ok: false, error: { code: 1, message: 'boom' } });
    const { ctrl } = make({ dispatch });
    await expect(ctrl.agentList(req, 'r1')).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
    });
  });

  it('maps an offline runner (RunnerCallError) to 503', async () => {
    const dispatch = jest.fn().mockRejectedValue(
      new RunnerCallError(RUNNER_CALL_ERRORS.RUNNER_OFFLINE, 'offline'),
    );
    const { ctrl } = make({ dispatch });
    await expect(ctrl.agentList(req, 'r1')).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });

  it('requires organization context', async () => {
    const { ctrl } = make();
    await expect(ctrl.agentList({ user: { id: 'u1' } }, 'r1')).rejects.toBeInstanceOf(HttpException);
  });
});
