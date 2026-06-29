import { Tool, ToolStatus } from '../../entities/tool.entity';
import { Runner, RunnerState } from '../../entities/runner.entity';
import { RunnerCapabilityPublisher } from './runner-capability.publisher';

class FakeRepo {
  rows: Tool[] = [];
  private idCounter = 0;
  manager = {
    transaction: async (fn: any) => fn({ getRepository: () => this as any }),
  };
  create(partial: Partial<Tool>) {
    return { id: `t_${++this.idCounter}`, ...partial } as Tool;
  }
  async save(tool: Tool) {
    this.rows.push(tool);
    return tool;
  }
  async delete(criteria: any) {
    if (criteria?.runnerConfig?.runnerId) {
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => r.runnerConfig?.runnerId !== criteria.runnerConfig.runnerId);
      return { affected: before - this.rows.length };
    }
    return { affected: 0 };
  }
  createQueryBuilder() {
    const self = this;
    const filters: Array<(r: Tool) => boolean> = [];
    let mode: 'select' | 'delete' = 'select';
    const qb: any = {
      delete: () => { mode = 'delete'; return qb; },
      from: () => qb,
      where: (_clause: string, params: any) => {
        filters.push((r) => r.runnerConfig?.runnerId === params.runnerId);
        return qb;
      },
      execute: async () => {
        if (mode === 'delete') {
          const before = self.rows.length;
          self.rows = self.rows.filter((r) => !filters.every((f) => f(r)));
          return { affected: before - self.rows.length };
        }
        return { affected: 0 };
      },
      getMany: async () => self.rows.filter((r) => filters.every((f) => f(r))),
    };
    return qb;
  }
}

function makeRunner(overrides: Partial<Runner> = {}): Runner {
  return {
    id: 'runner-1',
    name: 'laptop',
    organizationId: 'org-1',
    ownerUserId: 'user-1',
    state: RunnerState.REGISTERED,
    ...overrides,
  } as any as Runner;
}

describe('RunnerCapabilityPublisher', () => {
  it('publish mints one Tool row per capability with runnerConfig set', async () => {
    const repo = new FakeRepo();
    const pub = new RunnerCapabilityPublisher(repo as any);
    const rows = await pub.publish(makeRunner());
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const methods = rows.map((r) => r.runnerConfig?.method).sort();
    expect(methods).toEqual(['agent.list', 'runner.info', 'shell.exec']);
    for (const row of rows) {
      expect(row.runnerConfig?.runnerId).toBe('runner-1');
      expect(row.runnerConfig?.runnerName).toBe('laptop');
      expect(row.organizationId).toBe('org-1');
      expect(row.status).toBe(ToolStatus.ACTIVE);
      expect(row.name.startsWith('runner.laptop.')).toBe(true);
    }
    const shell = rows.find((r) => r.runnerConfig?.method === 'shell.exec')!;
    expect(shell.runnerConfig?.requiresWorkspace).toBe(true);
    const info = rows.find((r) => r.runnerConfig?.method === 'runner.info')!;
    expect(info.runnerConfig?.requiresWorkspace).toBe(false);
  });

  it('republish on the same runner deletes old rows and inserts fresh ones', async () => {
    const repo = new FakeRepo();
    const pub = new RunnerCapabilityPublisher(repo as any);
    const first = await pub.publish(makeRunner());
    const second = await pub.publish(makeRunner());
    // Same set of capabilities; rows are upserted (delete + insert),
    // never duplicated.
    expect(repo.rows.length).toBe(second.length);
    const idsFirst = new Set(first.map((r) => r.id));
    for (const row of repo.rows) {
      expect(idsFirst.has(row.id)).toBe(false);
    }
  });

  it('unpublish drops every capability for the runner', async () => {
    const repo = new FakeRepo();
    const pub = new RunnerCapabilityPublisher(repo as any);
    await pub.publish(makeRunner());
    const beforeCount = repo.rows.length;
    expect(beforeCount).toBeGreaterThan(0);
    const dropped = await pub.unpublish('runner-1');
    expect(dropped).toBe(beforeCount);
    expect(repo.rows.length).toBe(0);
  });

  it('unpublish leaves other runners alone', async () => {
    const repo = new FakeRepo();
    const pub = new RunnerCapabilityPublisher(repo as any);
    await pub.publish(makeRunner({ id: 'runner-1' }));
    await pub.publish(makeRunner({ id: 'runner-2', name: 'desktop' }));
    const before = repo.rows.length;
    await pub.unpublish('runner-1');
    expect(repo.rows.length).toBe(before / 2);
    for (const row of repo.rows) {
      expect(row.runnerConfig?.runnerId).toBe('runner-2');
    }
  });

  it('listForRunner returns only that runner\'s rows', async () => {
    const repo = new FakeRepo();
    const pub = new RunnerCapabilityPublisher(repo as any);
    await pub.publish(makeRunner({ id: 'runner-1' }));
    await pub.publish(makeRunner({ id: 'runner-2', name: 'desktop' }));
    const rows1 = await pub.listForRunner('runner-1');
    const rows2 = await pub.listForRunner('runner-2');
    expect(rows1.length).toBe(rows2.length);
    expect(rows1.every((r) => r.runnerConfig?.runnerId === 'runner-1')).toBe(true);
    expect(rows2.every((r) => r.runnerConfig?.runnerId === 'runner-2')).toBe(true);
  });
});
