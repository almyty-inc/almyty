import { DEFAULT_HOSTED_RUNNER_SETTINGS } from '../hosted-runner-settings';
import { HostedDispatchError, HostedRunnersService, machineFailing } from '../hosted-runners.service';
import { describeMachineError, isTerminalClusterError, redactSecrets } from '../../runner/hosted-dispatch';

/**
 * A machine that cannot start says so: the environment pages get its
 * error (secrets masked) and whether it is failing, and a call to it
 * carries the raw error so the run can fail naming it. A machine whose
 * provisioning kept failing used to read "waking" forever, with its error
 * nowhere on screen.
 */
describe('a hosted machine that cannot start', () => {
  const NOW = new Date('2026-10-21T12:00:00Z');
  const TLS = 'Get "https://k8s.example:6443/api": x509: certificate signed by unknown authority';
  const budget = DEFAULT_HOSTED_RUNNER_SETTINGS.wake.budgetSeconds;
  const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

  const service = (machine: Record<string, any>) => {
    const s = Object.create(HostedRunnersService.prototype) as HostedRunnersService;
    Object.assign(s as any, {
      settings: { current: DEFAULT_HOSTED_RUNNER_SETTINGS },
      enabled: () => true,
      workspaceFor: async () => ({ workspace: { id: 'ws-1', status: 'active' }, hostedRunner: machine }),
      touch: async () => undefined,
      runners: { findOne: async () => null },
      ensureAwake: async (hr: any) => hr,
    });
    return s;
  };

  describe('what the environment pages get', () => {
    it('exposes the last error, masked, and says a machine past the wake budget with an error is failing', () => {
      const view = service({}).machineView(
        { id: 'hr-1', state: 'provisioning', desired: { replicas: 1, resourceClass: 'small', wakeRequestedAt: ago(budget + 60) }, lastActiveAt: null, lastError: `${TLS} token=s3cr3t-value` },
        NOW,
      );
      expect(view).toMatchObject({ id: 'hr-1', state: 'provisioning', desired: { replicas: 1 }, failing: true });
      expect(view.lastError).toContain('x509');
      expect(view.lastError).not.toContain('s3cr3t-value');
      expect(view.problem).toEqual({ sentence: "Can't reach the cluster: its certificate isn't trusted", detail: expect.stringContaining('x509') });
      expect(view.problem!.detail).not.toContain('s3cr3t-value');
    });

    it('sends a problem only for a machine that has one to show', () => {
      const problem = (state: any, lastError: string | null) =>
        service({}).machineView({ id: 'hr-1', state, desired: { replicas: 1, resourceClass: 'small', wakeRequestedAt: ago(30) }, lastActiveAt: null, lastError }, NOW).problem;
      expect(problem('ready', 'old x509 error')).toBeNull();
      expect(problem('suspended', 'old x509 error')).toBeNull();
      expect(problem('provisioning', null)).toBeNull();
      expect(problem('pending', 'pods is forbidden (403)')).toEqual({ sentence: "The cluster rejected almyty's access", detail: 'pods is forbidden (403)' });
      expect(problem('failed', null)).toEqual({ sentence: "The machine couldn't start", detail: null });
    });

    it('a failed machine is failing; a wake still inside its budget, or with no error, is not', () => {
      expect(machineFailing({ state: 'failed', lastError: null, desired: { replicas: 1 } }, budget, NOW)).toBe(true);
      expect(machineFailing({ state: 'provisioning', lastError: TLS, desired: { replicas: 1, wakeRequestedAt: ago(30) } }, budget, NOW)).toBe(false);
      expect(machineFailing({ state: 'provisioning', lastError: null, desired: { replicas: 1, wakeRequestedAt: ago(budget + 60) } }, budget, NOW)).toBe(false);
      expect(machineFailing({ state: 'ready', lastError: TLS, desired: { replicas: 1, wakeRequestedAt: ago(budget + 60) } }, budget, NOW)).toBe(false);
    });
  });

  describe('what a call to it gets', () => {
    it('a failed machine refuses the call with its raw error and a sentence naming the problem', async () => {
      const s = service({ id: 'hr-1', state: 'failed', lastError: TLS, desired: { replicas: 1, resourceClass: 'small' } });
      const err: HostedDispatchError = await s.resolveTarget('env-1', { organizationId: 'org-1', callerUserId: 'u-1' } as any, NOW).catch((e) => e);
      expect(err).toBeInstanceOf(HostedDispatchError);
      expect(err.code).toBe('workspace_unavailable');
      expect(err.message).toContain("Can't reach the cluster: its certificate isn't trusted");
      expect(err.machine).toEqual({ failed: true, error: TLS });
    });

    it('a wake past its budget refuses the call the same way', async () => {
      const s = service({ id: 'hr-1', state: 'provisioning', lastError: TLS, desired: { replicas: 1, resourceClass: 'small', wakeRequestedAt: ago(budget + 60) } });
      const err: HostedDispatchError = await s.resolveTarget('env-1', { organizationId: 'org-1', callerUserId: 'u-1' } as any, NOW).catch((e) => e);
      expect(err.code).toBe('workspace_unavailable');
      expect(err.machine).toEqual({ failed: true, error: TLS });
    });

    it('a wake inside its budget is still waking', async () => {
      const s = service({ id: 'hr-1', state: 'provisioning', lastError: null, desired: { replicas: 1, resourceClass: 'small', wakeRequestedAt: ago(20) } });
      await expect(s.resolveTarget('env-1', { organizationId: 'org-1', callerUserId: 'u-1' } as any, NOW)).resolves.toMatchObject({ kind: 'waking' });
    });
  });

  describe('the sentence for each kind of error', () => {
    it.each([
      [TLS, "Can't reach the cluster: its certificate isn't trusted"],
      ['the server has asked for the client to provide credentials (401 Unauthorized)', "The cluster rejected almyty's access"],
      ['pods is forbidden: User "system:serviceaccount:almyty:runner" cannot create resource (403)', "The cluster rejected almyty's access"],
      ['0/3 nodes are available: 3 Insufficient cpu. FailedScheduling', 'Waiting for a free sandbox machine'],
      ['Back-off pulling image "ghcr.io/almyty/env:1": ImagePullBackOff', "Couldn't download the environment image"],
      ['Unauthorized (401)', "The cluster rejected almyty's access"],
      ['0/3 nodes are available: 3 Insufficient memory', 'Waiting for a free sandbox machine'],
      ['ErrImagePull: manifest unknown', "Couldn't download the environment image"],
      ['The image could not be pulled', "Couldn't download the environment image"],
      ['something else entirely', "The machine couldn't start"],
    ])('%s', (raw, sentence) => {
      expect(describeMachineError(raw)).toBe(sentence);
    });

    it('masks bearer tokens, key=value secrets and JWTs', () => {
      const raw = 'Authorization: Bearer abc123 api_key=k-999 eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl';
      const masked = redactSecrets(raw);
      expect(masked).not.toMatch(/abc123|k-999|eyJhbGciOi/);
    });
  });

  describe('which cluster errors fail a machine at once', () => {
    it.each([
      [Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }), true],
      [new Error(TLS), true],
      [Object.assign(new Error('create pod failed: HTTP 401'), { status: 401 }), true],
      [Object.assign(new Error('read pod failed'), { status: 403 }), true],
      [new Error('ErrImagePull: pulling image "registry.example/env:1": 401 Unauthorized'), false],
      [new Error('0/3 nodes are available: 3 Insufficient cpu'), false],
      [Object.assign(new Error('read pod failed: HTTP 503'), { status: 503 }), false],
      [new Error('socket hang up'), false],
    ])('%s -> %s', (error, terminal) => {
      expect(isTerminalClusterError(error)).toBe(terminal);
    });
  });
});
