import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { BadRequestException } from '@nestjs/common';

import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { Message } from '../../../entities/message.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { runsWithEvents } from '../../../test/fake-run-events';
import { AgentRuntimeService } from '../agent-runtime.service';
import { AgentRuntimeMiscHelper } from '../agent-runtime-misc.helper';
import { claimDelivery } from '../run-event-writer';
import { projectRunEvents, storedRunState } from '../run-events';

/**
 * Durable runs, step 1: every write of a run's state lands on its event
 * log, not only the step commit. Each writer outside the step is driven
 * here over the fake table, and its log has to be contiguous, end at the
 * row's headSeq, and fold back into exactly what the row holds.
 */
describe('run writes outside the step commit are on the run event log', () => {
  const RUN = 'run-1';

  const expectSound = (runs: ReturnType<typeof runsWithEvents>, id = RUN) => {
    const log = runs.events.rows(id);
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    const row = runs.row(id)!;
    expect(row.headSeq).toBe(log.length);
    const { headSeq, ...state } = projectRunEvents(log);
    expect(headSeq).toBe(row.headSeq);
    expect(state).toEqual(storedRunState(row));
  };

  const runtime = (runs: ReturnType<typeof runsWithEvents>) => {
    const messages = fakeRepository<Message>({ make: () => new Message(), idPrefix: 'msg' });
    const svc: any = Object.create(AgentRuntimeService.prototype);
    Object.assign(svc, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      runRepository: runs,
      messageRepository: messages,
      runtimeQueue: { add: jest.fn() },
      workspaceRepository: fakeRepository({ seed: [] }),
      emitEvent: jest.fn(),
      // The row as the controller loads it.
      getRun: jest.fn(async (id: string) => runs.row(id)),
    });
    return { svc, messages };
  };

  it('cancel: the status change, once; a run that already ended is refused and its log left alone', async () => {
    const runs = runsWithEvents([{ id: RUN, status: AgentRunStatus.RUNNING, currentStep: 2 }]);
    const { svc } = runtime(runs);

    await svc.cancelRun(RUN, 'org-1');

    expect(runs.row(RUN)!.status).toBe(AgentRunStatus.CANCELLED);
    expect(runs.events.rows(RUN).map((e) => e.type)).toEqual(['run_started', 'status_changed', 'step_committed']);
    expect(runs.events.rows(RUN)[1].payload).toEqual({ from: AgentRunStatus.RUNNING, to: AgentRunStatus.CANCELLED });
    expectSound(runs);

    await expect(svc.cancelRun(RUN, 'org-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(runs.events.rows(RUN)).toHaveLength(3);
  });

  it('cancel: a run that finished between the read and the write keeps its ending', async () => {
    const runs = runsWithEvents([{ id: RUN, status: AgentRunStatus.RUNNING }]);
    const { svc } = runtime(runs);
    // Loaded running; completed by its last step before the cancel's write.
    svc.getRun.mockImplementationOnce(async (id: string) => {
      const loaded = runs.row(id);
      await runs.update({ id }, { status: AgentRunStatus.COMPLETED });
      return loaded;
    });

    await expect(svc.cancelRun(RUN, 'org-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(runs.row(RUN)!.status).toBe(AgentRunStatus.COMPLETED);
    expect(runs.events.rows(RUN)).toEqual([]);
  });

  it('input: the resume and the message it came with (by id, not its words)', async () => {
    const runs = runsWithEvents([{ id: RUN, status: AgentRunStatus.WAITING_INPUT, conversationId: 'conv-1' }]);
    const { svc, messages } = runtime(runs);

    await svc.sendInput(RUN, 'org-1', 'ship it to Lisbon');

    const [message] = messages.rows();
    expect(runs.row(RUN)!.status).toBe(AgentRunStatus.RUNNING);
    const log = runs.events.rows(RUN);
    expect(log.map((e) => e.type)).toEqual(['run_started', 'input_received', 'status_changed', 'step_committed']);
    expect(log[1].payload).toEqual({ messageId: message.id, attachments: 0 });
    expect(JSON.stringify(log)).not.toContain('Lisbon');
    expect(svc.runtimeQueue.add).toHaveBeenCalledTimes(1);
    expectSound(runs);
  });

  it('input: a run that is not waiting is refused with nothing on its log', async () => {
    const runs = runsWithEvents([{ id: RUN, status: AgentRunStatus.RUNNING }]);
    const { svc } = runtime(runs);
    await expect(svc.sendInput(RUN, 'org-1', 'hello')).rejects.toBeInstanceOf(BadRequestException);
    expect(runs.events.rows(RUN)).toEqual([]);
  });

  it('delivery: claimed once, on the log once, however often it is asked', async () => {
    const runs = runsWithEvents([{ id: RUN, status: AgentRunStatus.COMPLETED }]);

    const claims = await Promise.all([claimDelivery(runs as any, RUN, 'schedule'), claimDelivery(runs as any, RUN, 'schedule')]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(runs.row(RUN)!.deliveredAt).toBeInstanceOf(Date);
    expect(runs.events.rows(RUN).filter((e) => e.type === 'delivery_claimed').map((e) => e.payload)).toEqual([{ via: 'schedule' }]);
    expectSound(runs);
  });

  it('a sub-agent waited on too long times out on its log; one that ended keeps its ending', async () => {
    const runs = runsWithEvents([
      { id: 'child-going', status: AgentRunStatus.RUNNING },
      { id: 'child-done', status: AgentRunStatus.COMPLETED, output: 'done' },
    ]);
    const misc = new AgentRuntimeMiscHelper({} as any, runs as any, {} as any);

    const timedOut = await misc.waitForRun('child-going', 0);
    const done = await misc.waitForRun('child-done', 0);

    expect(timedOut!.status).toBe(AgentRunStatus.TIMEOUT);
    expect(runs.row('child-going')!.error).toBe('Timed out waiting for sub-agent');
    expectSound(runs, 'child-going');
    expect(done!.status).toBe(AgentRunStatus.COMPLETED);
    expect(runs.events.rows('child-done')).toEqual([]);
  });
});

/**
 * The ratchet: nothing writes an agent_runs row except through
 * run-event-writer.ts (and the INSERT that creates a run, whose state the
 * first write's run_started records). A new `runRepository.update(...)`
 * or `.save(run)` would change a run with no event, so the log could no
 * longer stand in for the row.
 */
describe('no run write around the event log', () => {
  const SRC = join(__dirname, '..', '..', '..');

  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__tests__' || name === 'test' || name === 'migrations' ? [] : files(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    });

  /** A repository of AgentRun, by the field name the file injects it under. */
  const runRepositoryFields = (source: string): string[] => {
    const out: string[] = [];
    const injected = /@InjectRepository\(AgentRun\)\s*(?:private|public|protected)?\s*(?:readonly)?\s*(\w+)\??\s*:/g;
    for (let m = injected.exec(source); m; m = injected.exec(source)) out.push(m[1]);
    return out;
  };

  /** The one write allowed outside the writer: the INSERT of a new run (startRun's save of the row it created). */
  const CREATE = { file: 'modules/agents/agent-runtime.service.ts', text: 'const savedRun = await this.runRepository.save(run);' };

  it('every AgentRun repository write goes through writeRun', () => {
    const offenders: string[] = [];
    for (const path of files(SRC)) {
      const source = readFileSync(path, 'utf8');
      const rel = relative(SRC, path);
      for (const field of runRepositoryFields(source)) {
        const write = new RegExp(`this\\.${field}\\??\\.(update|save|insert|increment|decrement|upsert|query)\\(`, 'g');
        for (let m = write.exec(source); m; m = write.exec(source)) {
          if (rel === CREATE.file && source.startsWith(CREATE.text, m.index - CREATE.text.indexOf('this.'))) continue;
          offenders.push(`${rel}: this.${field}.${m[1]}(`);
        }
      }
      if (/getRepository\(AgentRun\)\.(update|save|insert)\(/.test(source) && rel !== 'modules/agents/run-event-writer.ts') {
        offenders.push(`${rel}: getRepository(AgentRun) write`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard sees the files it is meant to', () => {
    // A guard that found no injected AgentRun repository would pass whatever was written.
    const seen = files(SRC).filter((p) => runRepositoryFields(readFileSync(p, 'utf8')).length > 0).map((p) => relative(SRC, p));
    expect(seen).toEqual(expect.arrayContaining([
      'modules/agents/agent-runtime.service.ts',
      'modules/agents/agent-run-reaper.service.ts',
      'modules/approvals/approvals.service.ts',
      'modules/gateways/channels/channel-gateway.service.ts',
    ]));
  });
});

/**
 * Durable runs step 3: a step's writes of the run it holds are fenced on
 * its lease (run-lease.ts `heldBy`), so a worker whose lease was taken
 * over cannot write. Every write of `run.id` in the step processor and the
 * collaboration step has to carry the fence; a new one without it would
 * let a stale worker write over the one that took the run over.
 */
describe('writes under a lease are fenced', () => {
  const SRC = join(__dirname, '..', '..', '..');
  const LEASED = ['modules/agents/agent-step-processor.ts', 'modules/agents/agent-collaboration.helper.ts'];

  /** The first object literal at or after `from`: a write's where. */
  const objectAt = (source: string, from: number): string => {
    const start = source.indexOf('{', from);
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    return '';
  };

  it('every write of the leased run names heldBy(run) in its where', () => {
    const unfenced: string[] = [];
    let seen = 0;
    for (const rel of LEASED) {
      const source = readFileSync(join(SRC, rel), 'utf8');
      const call = /\b(writeRun|this\.persistWithEvents)\(/g;
      for (let m = call.exec(source); m; m = call.exec(source)) {
        const after = source.slice(m.index + m[0].length, m.index + m[0].length + 60);
        // The one generic write, inside persistWithEvents, takes its caller's guard.
        if (/^this\.s\.runRepository, guard,/.test(after)) continue;
        const where = objectAt(source, m.index);
        // A write of another run (a race's losers) is not the one held.
        if (!/\bid: run\.id\b/.test(where)) continue;
        seen++;
        if (!where.includes('...heldBy(run)')) unfenced.push(`${rel}: ${where.replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
    expect(unfenced).toEqual([]);
    // The commit, the cost of an abandoned step, the memory step after completion, the collaboration step.
    expect(seen).toBeGreaterThanOrEqual(4);
  });

  it('a step\'s progress (durable runs step 4) goes through writeRun, fenced like its commit', () => {
    const source = readFileSync(join(SRC, 'modules/agents/run-resume.ts'), 'utf8');
    const at = source.indexOf('writeRun(');
    expect(at).toBeGreaterThan(-1);
    const where = objectAt(source, at);
    expect(where).toContain('...heldBy(this.run)');
    expect(where).toContain('currentStep: this.step');
    expect(where).toContain('status: notDone()');
    expect(source.slice(at, at + 300)).toContain('{ progress: true }');
    // Nothing writes the run or its events around the writer.
    expect(source).not.toMatch(/\.(insert|save|update)\(/);
  });
});
