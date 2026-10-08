import {
  HostedActual,
  HostedAdapterCapabilities,
  HostedAdapterCredentials,
  HostedProvisionRequest,
  HostedRef,
  HostedRunnerAdapter,
  SANDBOX_RUNTIME_CLASS,
} from './hosted-runner-adapter.interface';

interface StubPod {
  ref: HostedRef;
  request: HostedProvisionRequest;
  replicas: 0 | 1;
  /** Whether the pod became ready after scale(1); a spec flips it. */
  ready: boolean;
  secretEnv: Record<string, string> | null;
  volume: boolean;
}

/**
 * In-memory hosted runners, for specs and a dev install with no cluster.
 * A pod "starts" on scale(1) and is ready at once unless `startPending`
 * says otherwise; nothing runs. Registered outside production only.
 */
export class StubHostedAdapter implements HostedRunnerAdapter {
  readonly key = 'stub';
  readonly internal = true;
  readonly pods = new Map<string, StubPod>();
  /** New pods stay not-ready until a spec calls markReady. */
  startPending = false;
  /** Make the next calls throw, to exercise the loop's error handling. */
  failNext: Array<'provision' | 'read' | 'scale' | 'rotate' | 'teardown'> = [];
  readonly calls: string[] = [];

  capabilities(): HostedAdapterCapabilities {
    return { runtimeClasses: [SANDBOX_RUNTIME_CLASS], volumeSnapshots: false };
  }

  private maybeFail(op: StubHostedAdapter['failNext'][number]): void {
    const at = this.failNext.indexOf(op);
    if (at >= 0) {
      this.failNext.splice(at, 1);
      throw new Error(`stub ${op} failed`);
    }
  }

  async provision(req: HostedProvisionRequest, _creds: HostedAdapterCredentials): Promise<HostedRef> {
    this.calls.push(`provision:${req.hostedRunnerId}`);
    this.maybeFail('provision');
    const ref: HostedRef = { stubId: req.hostedRunnerId, volume: `ws-${req.workspaceId}` };
    const existing = this.pods.get(req.hostedRunnerId);
    this.pods.set(req.hostedRunnerId, {
      ref,
      request: req,
      replicas: existing?.replicas ?? 0,
      ready: existing?.ready ?? false,
      secretEnv: existing?.secretEnv ?? null,
      volume: true,
    });
    return ref;
  }

  async read(ref: HostedRef, _creds: HostedAdapterCredentials): Promise<HostedActual> {
    this.calls.push(`read:${ref.stubId}`);
    this.maybeFail('read');
    const pod = this.pods.get(ref.stubId);
    if (!pod) return { exists: false, replicas: 0, readyReplicas: 0, pod: 'absent' };
    const readyReplicas = pod.replicas === 1 && pod.ready ? 1 : 0;
    return { exists: true, replicas: pod.replicas, readyReplicas, pod: pod.replicas === 0 ? 'absent' : readyReplicas ? 'running' : 'starting' };
  }

  async scale(ref: HostedRef, replicas: 0 | 1, _creds: HostedAdapterCredentials): Promise<void> {
    this.calls.push(`scale:${ref.stubId}:${replicas}`);
    this.maybeFail('scale');
    const pod = this.pods.get(ref.stubId);
    if (!pod) throw new Error('stub: no such hosted runner');
    pod.replicas = replicas;
    pod.ready = replicas === 1 ? !this.startPending : false;
  }

  async rotateEnrollment(ref: HostedRef, secretEnv: Record<string, string>, _creds: HostedAdapterCredentials): Promise<void> {
    this.calls.push(`rotate:${ref.stubId}`);
    this.maybeFail('rotate');
    const pod = this.pods.get(ref.stubId);
    if (!pod) throw new Error('stub: no such hosted runner');
    pod.secretEnv = { ...secretEnv };
  }

  async clearSecrets(ref: HostedRef, _creds: HostedAdapterCredentials): Promise<void> {
    this.calls.push(`clear:${ref.stubId}`);
    const pod = this.pods.get(ref.stubId);
    if (pod) pod.secretEnv = null;
  }

  async teardown(ref: HostedRef, opts: { keepVolume: boolean }, _creds: HostedAdapterCredentials): Promise<void> {
    this.calls.push(`teardown:${ref.stubId}:${opts.keepVolume ? 'keep' : 'delete'}`);
    this.maybeFail('teardown');
    this.pods.delete(ref.stubId);
  }

  /** A spec's hand on the pod: it became ready. */
  markReady(hostedRunnerId: string): void {
    const pod = this.pods.get(hostedRunnerId);
    if (pod) pod.ready = true;
  }

  /** A spec's hand on the cluster: it lost the objects. */
  forget(hostedRunnerId: string): void {
    this.pods.delete(hostedRunnerId);
  }
}
