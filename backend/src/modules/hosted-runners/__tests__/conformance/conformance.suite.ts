import { HostedAdapterCredentials, HostedRunnerAdapter, assertHostedAdapterContract } from '../../adapters/hosted-runner-adapter.interface';
import { provisionRequest } from '../fixtures';

/**
 * What every hosted runner adapter owes the reconcile loop, as one suite.
 * An adapter spec calls this with a factory and the credentials its
 * provider needs (the stub needs none; the kubernetes adapter a fake API
 * server). `afterScale` lets a spec play the cluster's part (a pod
 * becoming ready) where the adapter itself cannot.
 */
export function hostedAdapterConformance(
  name: string,
  setup: () => Promise<{ adapter: HostedRunnerAdapter; creds: HostedAdapterCredentials; teardown?: () => Promise<void>; afterScale?: (replicas: 0 | 1) => Promise<void> }>,
): void {
  describe(`${name}: hosted runner adapter conformance`, () => {
    let ctx: Awaited<ReturnType<typeof setup>>;

    beforeEach(async () => {
      ctx = await setup();
    });
    afterEach(async () => {
      await ctx.teardown?.();
    });

    it('meets the contract: a key, and gvisor as its runtime class', () => {
      expect(() => assertHostedAdapterContract(ctx.adapter)).not.toThrow();
      expect(ctx.adapter.capabilities().runtimeClasses).toContain('gvisor');
    });

    it('provisions at zero replicas, and provisioning twice is harmless', async () => {
      const req = provisionRequest();
      const ref = await ctx.adapter.provision(req, ctx.creds);
      expect(ref).toBeTruthy();
      expect(JSON.stringify(ref)).not.toContain(req.secretEnv.ALMYTY_ENROLLMENT_TOKEN);
      const again = await ctx.adapter.provision(req, ctx.creds);
      expect(again).toEqual(ref);
      const actual = await ctx.adapter.read(ref, ctx.creds);
      expect(actual).toMatchObject({ exists: true, replicas: 0, readyReplicas: 0 });
    });

    it('scales to one and back to zero, and reads what it did', async () => {
      const ref = await ctx.adapter.provision(provisionRequest(), ctx.creds);
      await ctx.adapter.rotateEnrollment(ref, { ALMYTY_ENROLLMENT_TOKEN: 'tok' }, ctx.creds);
      await ctx.adapter.scale(ref, 1, ctx.creds);
      await ctx.afterScale?.(1);
      expect(await ctx.adapter.read(ref, ctx.creds)).toMatchObject({ exists: true, replicas: 1, readyReplicas: 1, pod: 'running' });
      await ctx.adapter.scale(ref, 0, ctx.creds);
      await ctx.afterScale?.(0);
      expect(await ctx.adapter.read(ref, ctx.creds)).toMatchObject({ exists: true, replicas: 0, readyReplicas: 0 });
      await ctx.adapter.clearSecrets(ref, ctx.creds);
    });

    it('tears down so a read says the machine is gone', async () => {
      const ref = await ctx.adapter.provision(provisionRequest(), ctx.creds);
      await ctx.adapter.teardown(ref, { keepVolume: false }, ctx.creds);
      expect(await ctx.adapter.read(ref, ctx.creds)).toMatchObject({ exists: false, readyReplicas: 0 });
      // Tearing down what is gone is not an error.
      await expect(ctx.adapter.teardown(ref, { keepVolume: false }, ctx.creds)).resolves.toBeUndefined();
    });
  });
}
