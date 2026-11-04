import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { runsWithEvents } from '../../../test/fake-run-events';
import { fakeRepository } from '../../../test/fake-repository';
import { writeRun } from '../run-event-writer';
import { projectRunEvents, storedRunState } from '../run-events';
import { AgentStepProcessor } from '../agent-step-processor';
import { AgentBuiltInToolsHelper } from '../agent-builtin-tools.helper';
import { AgentRuntimeProcessor } from '../agent-runtime.processor';
import { RunWakeSweepService } from '../run-wake-sweep.service';
import { claimRun, heldBy, holdLease, releaseRunLease, renewRunLease, runLeaseConfig } from '../run-lease';

/**
 * Durable runs step 3: run leases (docs/design/durable-runs.md,
 * run-lease.ts). A worker processes a step only while it holds the run's
 * lease; it renews it while it works and lets it go when the step returns;
 * a lapsed lease is taken over, on the log, and the worker that lost it
 * cannot write. The queue only nudges, and the wake sweep nudges what is
 * due and nobody holds.
 */
describe('run leases', () => {
  const RUN = 'run-1';
  const LEASE = 60_000;
  const T0 = new Date('2026-11-04T10:00:00.000Z');
  const later = (ms: number) => new Date(T0.getTime() + ms);

  const seeded = (row: Partial<AgentRun> = {}) => runsWithEvents([{ id: RUN, status: AgentRunStatus.RUNNING, currentStep: 2, ...row }]);

  const expectSound = (runs: ReturnType<typeof runsWithEvents>) => {
    const log = runs.events.rows(RUN);
    const row = runs.row(RUN)!;
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(row.headSeq).toBe(log.length);
    const { headSeq, ...state } = projectRunEvents(log);
    expect(headSeq).toBe(row.headSeq);
    expect(state).toEqual(storedRunState(row));
  };

  describe('claim', () => {
    it('claims a due run with nobody holding it: a lease, and nothing on the log or in updatedAt', async () => {
      const stamped = new Date('2026-11-01T00:00:00.000Z');
      const runs = seeded({ nextWakeAt: T0, updatedAt: stamped });

      const claim = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });

      expect(claim).toMatchObject({ claimed: true, attempt: 0, takenOver: false });
      const row = runs.row(RUN)!;
      expect(row.leaseOwner).toBe((claim as any).owner);
      expect(row.leaseExpiresAt).toEqual(later(LEASE));
      expect(row.headSeq).toBe(0);
      expect(runs.events.rows(RUN)).toEqual([]);
      // Holding a run is not progress: the reaper reads updatedAt as progress.
      expect(row.updatedAt).toEqual(stamped);
    });

    it('a run with no wake time is due (a run not yet written since it was created)', async () => {
      const runs = seeded();
      expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 })).toMatchObject({ claimed: true });
    });

    it('each claim has its own token, so two claims of one worker are told apart', async () => {
      const runs = seeded();
      const first = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });
      await releaseRunLease(runs as any, RUN, (first as any).owner);
      const second = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });
      expect((first as any).owner).not.toBe((second as any).owner);
    });

    it('refuses a run another worker holds, until its lease lapses', async () => {
      const runs = seeded();
      const held = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });
      expect(held.claimed).toBe(true);

      expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(LEASE - 1) })).toEqual({ claimed: false, reason: 'held' });
      expect(runs.row(RUN)!.leaseOwner).toBe((held as any).owner);
    });

    it('two workers claiming at once: one gets it', async () => {
      const runs = seeded();
      const claims = await Promise.all([1, 2, 3].map(() => claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 })));
      expect(claims.filter((c) => c.claimed)).toHaveLength(1);
    });

    it('a sleeping run is not claimed before its wake time, and is at it', async () => {
      const runs = seeded({ status: AgentRunStatus.SLEEPING, nextWakeAt: later(30_000) });
      expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 })).toEqual({ claimed: false, reason: 'not_due' });
      expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(30_000) })).toMatchObject({ claimed: true });
    });

    it.each([AgentRunStatus.WAITING_INPUT, AgentRunStatus.WAITING_APPROVAL])('a run %s is not claimed: a person wakes it', async (status) => {
      const runs = seeded({ status, nextWakeAt: null });
      expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 })).toEqual({ claimed: false, reason: 'not_due' });
    });

    it('a finished run, or none, is not claimed', async () => {
      const runs = seeded({ status: AgentRunStatus.COMPLETED });
      expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 })).toEqual({ claimed: false, reason: 'done' });
      expect(await claimRun(runs as any, 'nope', { leaseMs: LEASE, now: T0 })).toEqual({ claimed: false, reason: 'missing' });
    });

    it('a nudge for a step the run is past claims nothing', async () => {
      const runs = seeded({ currentStep: 3 });
      expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, step: 2, now: T0 })).toEqual({ claimed: false, reason: 'moved_on' });
      expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, step: 3, now: T0 })).toMatchObject({ claimed: true });
    });
  });

  describe('takeover', () => {
    it('takes over a lapsed lease: attempt + 1, lease_taken_over on the log, the log still sound', async () => {
      const runs = seeded({ workingMemory: { a: 1 }, steps: [{ type: 'llm_call', output: 'x' } as any] });
      const dead = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });

      const taken = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(LEASE + 1) });

      expect(taken).toMatchObject({ claimed: true, attempt: 1, takenOver: true });
      const row = runs.row(RUN)!;
      expect(row.attempt).toBe(1);
      expect(row.leaseOwner).toBe((taken as any).owner);
      expect(row.leaseOwner).not.toBe((dead as any).owner);
      const log = runs.events.rows(RUN);
      expect(log.map((e) => e.type)).toEqual(['run_started', 'lease_taken_over', 'step_committed']);
      expect(log[1].payload).toEqual({ attempt: 1, lapsedAt: later(LEASE).toISOString() });
      // The worker's identity is not on the log a viewer reads.
      expect(JSON.stringify(log[1].payload)).not.toContain(String(process.pid));
      expectSound(runs);
    });

    it('counts every takeover', async () => {
      const runs = seeded();
      await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });
      await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(LEASE + 1) });
      const third = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(2 * LEASE + 2) });
      expect(third).toMatchObject({ attempt: 2, takenOver: true });
      expect(runs.events.rows(RUN).filter((e) => e.type === 'lease_taken_over').map((e) => e.payload.attempt)).toEqual([1, 2]);
      expectSound(runs);
    });

    describe('the takeover cap (RUN_MAX_TAKEOVERS)', () => {
      const STOPPED = 'This step stopped its worker 3 times in a row, so the run was stopped.';
      /** The lease taken over `n` times, each claim's lease left to lapse. */
      const lapseAndClaim = async (runs: ReturnType<typeof seeded>, from: number, n: number, max = 3) => {
        const claims = [];
        for (let i = 0; i < n; i++) claims.push(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later((from + i) * (LEASE + 1)), maxTakeovers: max }));
        return claims;
      };

      it('the third takeover of one step fails the run instead of starting it again, on the log', async () => {
        const runs = seeded({ workingMemory: { a: 1 } });
        const claims = await lapseAndClaim(runs, 0, 4);

        expect(claims[0]).toMatchObject({ claimed: true, takenOver: false });
        expect(claims[1]).toMatchObject({ claimed: true, takenOver: true, attempt: 1 });
        expect(claims[2]).toMatchObject({ claimed: true, takenOver: true, attempt: 2 });
        expect(claims[3]).toEqual({ claimed: false, reason: 'stopped', error: STOPPED, attempt: 3 });

        const row = runs.row(RUN)!;
        expect(row.status).toBe(AgentRunStatus.FAILED);
        expect(row.error).toBe(STOPPED);
        expect(row.leaseOwner).toBeNull();
        expect(row.leaseExpiresAt).toBeNull();
        expect(row.nextWakeAt).toBeNull();
        expect(row.attempt).toBe(3);
        expect(row.takeovers).toBe(3);
        const log = runs.events.rows(RUN);
        const last = log.slice(-4);
        expect(last.map((e) => e.type)).toEqual(['lease_taken_over', 'status_changed', 'run_failed', 'step_committed']);
        expect(last[2].payload).toEqual({ error: STOPPED });
        expectSound(runs);

        // Finished: nothing claims it again.
        expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(10 * LEASE) })).toEqual({ claimed: false, reason: 'done' });
      });

      it('a step that commits resets the count', async () => {
        const runs = seeded();
        const processor = new AgentStepProcessor({ runRepository: runs, logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() } } as any, {} as any, {} as any, {} as any);
        const claims = await lapseAndClaim(runs, 0, 3);
        expect(runs.row(RUN)!.takeovers).toBe(2);

        // The worker holding it commits step 2 (asleep until the next claim, so the clock here decides when it is due).
        const run: any = Object.assign(new AgentRun(), {
          ...runs.row(RUN),
          leaseOwner: (claims[2] as any).owner,
          currentStep: 3,
          steps: [],
          status: AgentRunStatus.SLEEPING,
          nextWakeAt: later(3 * (LEASE + 1)),
        });
        expect(await (processor as any).commitStep(run, 2)).toBe(true);
        expect(runs.row(RUN)!.takeovers).toBe(0);

        // Two more takeovers of step 3 restart it; the third of step 3 stops the run.
        const again = await lapseAndClaim(runs, 3, 3);
        expect(again[0]).toMatchObject({ claimed: true, takenOver: true, attempt: 3 });
        expect(again[1]).toMatchObject({ claimed: true, takenOver: true, attempt: 4 });
        expect(again[2]).toMatchObject({ claimed: false, reason: 'stopped' });
        expect(runs.row(RUN)!.status).toBe(AgentRunStatus.FAILED);
        expectSound(runs);
      });

      it('the collaboration step commit resets the count too', async () => {
        const { AgentCollaborationHelper } = await import('../agent-collaboration.helper');
        const runs = seeded();
        const claims = await lapseAndClaim(runs, 0, 2);
        expect(runs.row(RUN)!.takeovers).toBe(1);
        const helper: any = Object.create(AgentCollaborationHelper.prototype);
        helper.runRepository = runs;
        helper.logger = { warn: jest.fn() };
        const run: any = Object.assign(new AgentRun(), { ...runs.row(RUN), leaseOwner: (claims[1] as any).owner, currentStep: 3, steps: [] });
        await helper.persist(run);
        expect(runs.row(RUN)!.currentStep).toBe(3);
        expect(runs.row(RUN)!.takeovers).toBe(0);
      });

      it('takes the cap from its option: 1 stops the run at its first takeover', async () => {
        const runs = seeded();
        const claims = await lapseAndClaim(runs, 0, 2, 1);
        expect(claims[1]).toEqual({ claimed: false, reason: 'stopped', error: 'This step stopped its worker once in a row, so the run was stopped.', attempt: 1 });
      });

      it('reads the cap from RUN_MAX_TAKEOVERS when the caller names none', async () => {
        const saved = process.env.RUN_MAX_TAKEOVERS;
        process.env.RUN_MAX_TAKEOVERS = '2';
        try {
          const runs = seeded();
          await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });
          expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(LEASE + 1) })).toMatchObject({ claimed: true, takenOver: true });
          expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(2 * LEASE + 2) })).toMatchObject({
            claimed: false,
            reason: 'stopped',
            error: 'This step stopped its worker 2 times in a row, so the run was stopped.',
          });
        } finally {
          if (saved === undefined) delete process.env.RUN_MAX_TAKEOVERS;
          else process.env.RUN_MAX_TAKEOVERS = saved;
        }
      });
    });
  });

  describe('fencing', () => {
    it('the worker whose lease was taken over cannot write; the one that holds it can', async () => {
      const runs = seeded();
      const a = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });
      const b = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(LEASE + 1) });

      const stale = await writeRun(runs as any, { id: RUN, currentStep: 2, ...heldBy({ leaseOwner: (a as any).owner }) }, { currentStep: 3, output: 'from a' });
      expect(stale).toBeNull();
      expect(runs.row(RUN)!.currentStep).toBe(2);

      const live = await writeRun(runs as any, { id: RUN, currentStep: 2, ...heldBy({ leaseOwner: (b as any).owner }) }, { currentStep: 3, output: 'from b' });
      expect(live).not.toBeNull();
      expect(runs.row(RUN)!.output).toBe('from b');
      expect(runs.events.rows(RUN).some((e) => JSON.stringify(e.payload).includes('from a'))).toBe(false);
      expectSound(runs);
    });

    it('a lapsed lease nobody took over still lets its holder commit', async () => {
      const runs = seeded();
      const a = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });
      expect(await writeRun(runs as any, { id: RUN, ...heldBy({ leaseOwner: (a as any).owner }) }, { currentStep: 3 })).not.toBeNull();
    });

    it('a run not processed under a lease adds no fence', () => {
      expect(heldBy({ leaseOwner: null })).toEqual({});
      expect(heldBy(undefined)).toEqual({});
      expect(heldBy({ leaseOwner: 'w:1' })).toEqual({ leaseOwner: 'w:1' });
    });

    it('the step commit is fenced: a step that lost its lease is refused', async () => {
      const runs = seeded();
      const processor = new AgentStepProcessor({ runRepository: runs, logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() } } as any, {} as any, {} as any, {} as any);
      const a = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });
      await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(LEASE + 1) });
      const run: any = Object.assign(new AgentRun(), { ...runs.row(RUN), leaseOwner: (a as any).owner, currentStep: 3, totalCost: 1, steps: [] });

      expect(await (processor as any).commitStep(run, 2)).toBe(false);
      expect(runs.row(RUN)!.currentStep).toBe(2);
      expect(runs.row(RUN)!.totalCost ?? 0).toBe(0);

      run.leaseOwner = runs.row(RUN)!.leaseOwner;
      expect(await (processor as any).commitStep(run, 2)).toBe(true);
      expect(runs.row(RUN)!.currentStep).toBe(3);
    });
  });

  describe('renew and release', () => {
    it('renewal extends the lease; after a takeover it reports the lease gone and changes nothing', async () => {
      const runs = seeded();
      const a = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });
      expect(await renewRunLease(runs as any, RUN, (a as any).owner, LEASE, later(20_000))).toBe(true);
      expect(runs.row(RUN)!.leaseExpiresAt).toEqual(later(80_000));
      // Not lapsed at the old expiry any more.
      expect(await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(LEASE + 1) })).toEqual({ claimed: false, reason: 'held' });

      const b = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(80_001) });
      expect(await renewRunLease(runs as any, RUN, (a as any).owner, LEASE, later(80_002))).toBe(false);
      expect(runs.row(RUN)!.leaseOwner).toBe((b as any).owner);
      expect(runs.row(RUN)!.headSeq).toBe(runs.events.rows(RUN).length);
    });

    it('release lets go of the lease; a stale holder releasing changes nothing', async () => {
      const runs = seeded();
      const a = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: T0 });
      const b = await claimRun(runs as any, RUN, { leaseMs: LEASE, now: later(LEASE + 1) });
      expect(await releaseRunLease(runs as any, RUN, (a as any).owner)).toBe(false);
      expect(runs.row(RUN)!.leaseOwner).toBe((b as any).owner);
      expect(await releaseRunLease(runs as any, RUN, (b as any).owner)).toBe(true);
      expect(runs.row(RUN)!.leaseOwner).toBeNull();
      expect(runs.row(RUN)!.leaseExpiresAt).toBeNull();
    });

    it('holdLease renews on its timer until released, and marks a lease it lost', async () => {
      jest.useFakeTimers();
      try {
        const runs = seeded();
        const a = await claimRun(runs as any, RUN, { leaseMs: LEASE });
        const warn = jest.fn();
        const held = holdLease(runs as any, RUN, (a as any).owner, { leaseMs: LEASE, renewMs: 1_000 }, { warn });
        const before = runs.row(RUN)!.leaseExpiresAt!.getTime();
        jest.setSystemTime(Date.now() + 5_000);
        await jest.advanceTimersByTimeAsync(1_000);
        expect(runs.row(RUN)!.leaseExpiresAt!.getTime()).toBeGreaterThan(before);

        // Taken over (its lease forced to lapse): the next renewal finds it gone.
        await writeRun(runs as any, { id: RUN }, { leaseOwner: 'other:claim' });
        await jest.advanceTimersByTimeAsync(1_000);
        expect(held.lost).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Lost the lease'));
        await held.release();
        expect(runs.row(RUN)!.leaseOwner).toBe('other:claim');
      } finally {
        jest.useRealTimers();
      }
    });

    it('holdLease release clears the lease and stops renewing', async () => {
      jest.useFakeTimers();
      try {
        const runs = seeded();
        const a = await claimRun(runs as any, RUN, { leaseMs: LEASE });
        const held = holdLease(runs as any, RUN, (a as any).owner, { leaseMs: LEASE, renewMs: 1_000 }, { warn: jest.fn() });
        await held.release();
        expect(runs.row(RUN)!.leaseOwner).toBeNull();
        await jest.advanceTimersByTimeAsync(5_000);
        expect(runs.row(RUN)!.leaseOwner).toBeNull();
        expect(runs.row(RUN)!.leaseExpiresAt).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('when a run next needs a worker (writeRun)', () => {
    it.each([
      [AgentRunStatus.RUNNING, 'now'],
      [AgentRunStatus.PENDING, 'now'],
      [AgentRunStatus.WAITING_INPUT, null],
      [AgentRunStatus.WAITING_APPROVAL, null],
      [AgentRunStatus.COMPLETED, null],
      [AgentRunStatus.CANCELLED, null],
    ])('a write leaving it %s sets nextWakeAt to %s', async (status, expected) => {
      const runs = seeded({ status: AgentRunStatus.SLEEPING, nextWakeAt: new Date('2020-01-01T00:00:00.000Z') });
      const before = Date.now();
      await writeRun(runs as any, { id: RUN }, { status });
      const wake = runs.row(RUN)!.nextWakeAt;
      if (expected === null) expect(wake).toBeNull();
      else expect(wake!.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('a sleep keeps the wake time its step wrote; a write that does not set the status leaves it', async () => {
      const wakeAt = later(90_000);
      const runs = seeded();
      await writeRun(runs as any, { id: RUN }, { status: AgentRunStatus.SLEEPING, nextWakeAt: wakeAt });
      expect(runs.row(RUN)!.nextWakeAt).toEqual(wakeAt);
      await writeRun(runs as any, { id: RUN }, (row) => ({ metadata: { ...(row.metadata ?? {}), k: 1 } }));
      expect(runs.row(RUN)!.nextWakeAt).toEqual(wakeAt);
      expectSound(runs);
    });

    it('a narrow read may change lease columns only', async () => {
      const runs = seeded();
      await expect(writeRun(runs as any, { id: RUN }, { output: 'x' }, [], { select: ['leaseOwner'] })).rejects.toThrow(/lease columns only/);
    });
  });

  describe('the sleep goes to nextWakeAt', () => {
    it('the wait tool sets the wake time and queues nothing itself', async () => {
      const queue = { add: jest.fn() };
      const helper = new AgentBuiltInToolsHelper({} as any, queue as any, {} as any, {} as any);
      const run: any = { id: RUN, status: AgentRunStatus.RUNNING };
      const before = Date.now();

      const out = await helper.executeBuiltInTool('wait', { seconds: 30 }, run, {} as any);

      expect(out?.status).toBe('sleeping');
      expect(run.status).toBe(AgentRunStatus.SLEEPING);
      expect(run.nextWakeAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('the commit of a sleeping step writes the wake time', async () => {
      const runs = seeded();
      const processor = new AgentStepProcessor({ runRepository: runs, logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn() } } as any, {} as any, {} as any, {} as any);
      const wakeAt = later(30_000);
      const run: any = Object.assign(new AgentRun(), { ...runs.row(RUN), status: AgentRunStatus.SLEEPING, nextWakeAt: wakeAt, currentStep: 3 });
      expect(await (processor as any).commitStep(run, 2)).toBe(true);
      expect(runs.row(RUN)!.nextWakeAt).toEqual(wakeAt);
    });
  });

  describe('processStep holds the lease', () => {
    const harness = (row: Partial<AgentRun>) => {
      const runs = seeded(row);
      const queue = { add: jest.fn(async () => ({})) };
      const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
      const processor = new AgentStepProcessor({ runRepository: runs, runtimeQueue: queue, logger } as any, {} as any, {} as any, {} as any);
      return { runs, queue, processor };
    };

    it('a run another worker holds is not processed: held', async () => {
      const { runs, processor } = harness({});
      await claimRun(runs as any, RUN, { leaseMs: LEASE });
      const leased = jest.spyOn(processor as any, 'processLeasedStep');
      expect(await processor.processStep(RUN)).toBe('held');
      expect(leased).not.toHaveBeenCalled();
    });

    it('a nudge for a step already done is not processed: held', async () => {
      const { processor } = harness({ currentStep: 5 });
      const leased = jest.spyOn(processor as any, 'processLeasedStep');
      expect(await processor.processStep(RUN, { step: 4 })).toBe('held');
      expect(leased).not.toHaveBeenCalled();
    });

    it('a finished run is done, as before', async () => {
      const { processor } = harness({ status: AgentRunStatus.FAILED });
      expect(await processor.processStep(RUN)).toBe('done');
    });

    it('a run stopped by the takeover cap is not processed: run.failed goes out with the error, and it is done', async () => {
      const saved = process.env.RUN_MAX_TAKEOVERS;
      process.env.RUN_MAX_TAKEOVERS = '1';
      try {
        const runs = seeded({ nextWakeAt: new Date(Date.now() - 1000) });
        const emitEvent = jest.fn();
        const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
        const processor = new AgentStepProcessor({ runRepository: runs, runtimeQueue: { add: jest.fn() }, logger, emitEvent } as any, {} as any, {} as any, {} as any);
        // A worker claimed it and died: its lease lapsed a while ago.
        await claimRun(runs as any, RUN, { leaseMs: 1, now: new Date(Date.now() - 1000), maxTakeovers: 1 });
        const leased = jest.spyOn(processor as any, 'processLeasedStep');

        expect(await processor.processStep(RUN)).toBe('done');

        expect(leased).not.toHaveBeenCalled();
        const error = 'This step stopped its worker once in a row, so the run was stopped.';
        expect(emitEvent).toHaveBeenCalledWith(RUN, 'run.failed', { error, reasonCode: 'TAKEOVER_LIMIT' });
        expect(runs.row(RUN)).toMatchObject({ status: AgentRunStatus.FAILED, error, leaseOwner: null });
        expect(runs.events.rows(RUN).some((e) => e.type === 'run_failed' && e.payload.error === error)).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.RUN_MAX_TAKEOVERS;
        else process.env.RUN_MAX_TAKEOVERS = saved;
      }
    });

    it('the step runs holding the lease, and lets it go when it returns or throws', async () => {
      const { runs, processor } = harness({});
      let during: string | null | undefined;
      jest.spyOn(processor as any, 'processLeasedStep').mockImplementationOnce(async (_id: any, owner: any) => {
        during = runs.row(RUN)!.leaseOwner;
        expect(owner).toBe(during);
        return 'continue';
      });
      expect(await processor.processStep(RUN)).toBe('continue');
      expect(during).toEqual(expect.any(String));
      expect(runs.row(RUN)!.leaseOwner).toBeNull();

      jest.spyOn(processor as any, 'processLeasedStep').mockRejectedValueOnce(new Error('model down'));
      await expect(processor.processStep(RUN)).rejects.toThrow('model down');
      expect(runs.row(RUN)!.leaseOwner).toBeNull();
    });

    it('a step that leaves the run asleep queues its wake for the wake time', async () => {
      const { runs, queue, processor } = harness({});
      const wakeAt = new Date(Date.now() + 45_000);
      jest.spyOn(processor as any, 'processLeasedStep').mockImplementationOnce(async () => {
        await writeRun(runs as any, { id: RUN }, { status: AgentRunStatus.SLEEPING, nextWakeAt: wakeAt, currentStep: 3 });
        return 'waiting';
      });
      expect(await processor.processStep(RUN)).toBe('waiting');
      expect(queue.add).toHaveBeenCalledTimes(1);
      const [name, data, opts] = (queue.add as jest.Mock).mock.calls[0];
      expect(name).toBe('next-step');
      expect(data).toEqual({ runId: RUN, seq: wakeAt.getTime(), step: 3 });
      expect(opts.jobId).toBe(`step:${RUN}:${wakeAt.getTime()}`);
      expect(opts.delay).toBeGreaterThan(40_000);
      expect(opts.delay).toBeLessThanOrEqual(45_000);
    });

    it('a run waiting on a person queues nothing', async () => {
      const { runs, queue, processor } = harness({});
      jest.spyOn(processor as any, 'processLeasedStep').mockImplementationOnce(async () => {
        await writeRun(runs as any, { id: RUN }, { status: AgentRunStatus.WAITING_INPUT });
        return 'waiting';
      });
      expect(await processor.processStep(RUN)).toBe('waiting');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('a sleeping run that is due runs again as running', async () => {
      const { runs, processor } = harness({ status: AgentRunStatus.SLEEPING, nextWakeAt: new Date(Date.now() - 1_000) });
      const s: any = (processor as any).s;
      let status: string | undefined;
      // Stop right after the run is loaded and woken.
      s.misc = { resolveLimits: jest.fn(async (run: AgentRun) => { status = run.status; throw new Error('stop here'); }) };
      jest.spyOn(processor as any, 'loadOrganization').mockResolvedValue({});
      await expect(processor.processStep(RUN)).rejects.toThrow('stop here');
      expect(status).toBe(AgentRunStatus.RUNNING);
      expect(runs.row(RUN)!.leaseOwner).toBeNull();
    });
  });

  describe('the queue only nudges', () => {
    const processorWith = (processStep: jest.Mock, runs = seeded()) => {
      const queue = { add: jest.fn(async () => ({})) };
      const p = new AgentRuntimeProcessor({ processStep } as any, queue as any, {} as any, runs as any);
      return { p, queue };
    };

    it('a job that claims nothing does nothing', async () => {
      const processStep = jest.fn(async () => 'held');
      const { p, queue } = processorWith(processStep);
      await p.handleNextStep({ id: 'j', data: { runId: RUN, seq: 4, step: 2 } } as any);
      expect(processStep).toHaveBeenCalledWith(RUN, { step: 2 });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('the next step is queued for the step the run is at after the commit', async () => {
      const runs = seeded({ currentStep: 7 });
      const processStep = jest.fn(async () => 'continue');
      const { p, queue } = processorWith(processStep, runs);
      await p.handleNextStep({ id: 'j', data: { runId: RUN, seq: 4 } } as any);
      expect(processStep).toHaveBeenCalledWith(RUN, {});
      expect(queue.add).toHaveBeenCalledWith('next-step', expect.objectContaining({ runId: RUN, seq: 5, step: 7 }), expect.objectContaining({ jobId: `step:${RUN}:5` }));
    });
  });

  describe('the wake sweep', () => {
    const NOW = new Date('2026-11-04T12:00:00.000Z');
    const ago = (ms: number) => new Date(NOW.getTime() - ms);

    it('nudges runs past due with nobody holding them, for the step they are at, and nothing else', async () => {
      const runs = fakeRepository<AgentRun>({
        make: () => new AgentRun(),
        seed: [
          { id: 'lost-nudge', status: AgentRunStatus.RUNNING, currentStep: 4, nextWakeAt: ago(60_000), leaseOwner: null, leaseExpiresAt: null },
          { id: 'dead-worker', status: AgentRunStatus.RUNNING, currentStep: 2, nextWakeAt: ago(120_000), leaseOwner: 'gone:1', leaseExpiresAt: ago(1) },
          { id: 'overslept', status: AgentRunStatus.SLEEPING, currentStep: 1, nextWakeAt: ago(45_000), leaseOwner: null, leaseExpiresAt: null },
          { id: 'held', status: AgentRunStatus.RUNNING, currentStep: 1, nextWakeAt: ago(600_000), leaseOwner: 'live:1', leaseExpiresAt: new Date(NOW.getTime() + 10_000) },
          { id: 'just-committed', status: AgentRunStatus.RUNNING, currentStep: 1, nextWakeAt: ago(1_000), leaseOwner: null, leaseExpiresAt: null },
          { id: 'asleep', status: AgentRunStatus.SLEEPING, currentStep: 1, nextWakeAt: new Date(NOW.getTime() + 60_000), leaseOwner: null, leaseExpiresAt: null },
          { id: 'asking', status: AgentRunStatus.WAITING_INPUT, currentStep: 1, nextWakeAt: null as any, leaseOwner: null, leaseExpiresAt: null },
          { id: 'finished', status: AgentRunStatus.COMPLETED, currentStep: 1, nextWakeAt: ago(600_000), leaseOwner: null, leaseExpiresAt: null },
        ],
      });
      const queue = { add: jest.fn(async () => ({})) };
      const sweep = new RunWakeSweepService(runs as any, queue as any);

      expect(await sweep.sweep(NOW)).toBe(3);

      const calls = (queue.add as jest.Mock).mock.calls.map(([name, data, opts]) => ({ name, data, opts }));
      expect(calls.map((c) => c.data.runId).sort()).toEqual(['dead-worker', 'lost-nudge', 'overslept']);
      const lost = calls.find((c) => c.data.runId === 'lost-nudge')!;
      expect(lost.name).toBe('next-step');
      expect(lost.data.step).toBe(4);
      expect(lost.opts).toMatchObject({ jobId: `wake:lost-nudge:${ago(60_000).getTime()}`, removeOnComplete: true, removeOnFail: true });
    });

    it('reads its grace from the environment', async () => {
      const runs = fakeRepository<AgentRun>({
        make: () => new AgentRun(),
        seed: [{ id: 'r', status: AgentRunStatus.RUNNING, currentStep: 0, nextWakeAt: ago(5_000), leaseOwner: null, leaseExpiresAt: null }],
      });
      const queue = { add: jest.fn(async () => ({})) };
      const sweep = new RunWakeSweepService(runs as any, queue as any);
      const saved = process.env.RUN_WAKE_GRACE_MS;
      try {
        expect(await sweep.sweep(NOW)).toBe(0);
        process.env.RUN_WAKE_GRACE_MS = '1000';
        expect(await sweep.sweep(NOW)).toBe(1);
      } finally {
        if (saved === undefined) delete process.env.RUN_WAKE_GRACE_MS;
        else process.env.RUN_WAKE_GRACE_MS = saved;
      }
    });
  });

  describe('config', () => {
    it('has defaults and reads each setting from the environment', () => {
      expect(runLeaseConfig({})).toEqual({ leaseMs: 60_000, renewMs: 20_000, sweepIntervalMs: 15_000, wakeGraceMs: 30_000, maxTakeovers: 3 });
      expect(
        runLeaseConfig({ RUN_LEASE_MS: '9000', RUN_LEASE_RENEW_MS: '2000', RUN_WAKE_SWEEP_INTERVAL_MS: '500', RUN_WAKE_GRACE_MS: '700', RUN_MAX_TAKEOVERS: '5' }),
      ).toEqual({
        leaseMs: 9000,
        renewMs: 2000,
        sweepIntervalMs: 500,
        wakeGraceMs: 700,
        maxTakeovers: 5,
      });
    });

    it('takes a whole number of takeovers, at least 1', () => {
      expect(runLeaseConfig({ RUN_MAX_TAKEOVERS: '0' }).maxTakeovers).toBe(3);
      expect(runLeaseConfig({ RUN_MAX_TAKEOVERS: 'many' }).maxTakeovers).toBe(3);
      expect(runLeaseConfig({ RUN_MAX_TAKEOVERS: '0.5' }).maxTakeovers).toBe(1);
      expect(runLeaseConfig({ RUN_MAX_TAKEOVERS: '4.7' }).maxTakeovers).toBe(4);
    });

    it('renews at most every half lease, and ignores a value that is not a positive number', () => {
      expect(runLeaseConfig({ RUN_LEASE_MS: '10000', RUN_LEASE_RENEW_MS: '9000' }).renewMs).toBe(5000);
      expect(runLeaseConfig({ RUN_LEASE_MS: 'soon', RUN_WAKE_GRACE_MS: '-1' })).toMatchObject({ leaseMs: 60_000, wakeGraceMs: 30_000 });
    });
  });
});
