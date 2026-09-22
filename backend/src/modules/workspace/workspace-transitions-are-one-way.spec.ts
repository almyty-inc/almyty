import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Runner, RunnerIsolationTier } from '../../entities/runner.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { WorkspaceService } from './workspace.service';

/**
 * A workspace's terminal state is a fact about what happened to it, and
 * three writers compete for it: the owner's release, the TTL sweep, and
 * the stranding fan-out that fires when the pinned runner goes offline.
 *
 * All three used to do `ws.status = X; save(ws)` on an entity loaded
 * before the others committed, so whichever finished last decided what
 * the record said — and the one that matters most is `stranded`, which
 * exists purely to tell the user their work was on a machine that went
 * away. Losing it destroys the signal the state is for.
 *
 * The fake models TypeORM honestly: `find`/`findOne` hand out detached
 * copies (as a real read does) and `save` writes every column of the
 * copy onto the stored row, so a stale snapshot really can overwrite a
 * committed one. A fake that shared one object between the three would
 * show nothing however the service was written.
 */
describe('workspace terminal states are one-way', () => {
  let service: WorkspaceService;
  let store: Map<string, Workspace>;
  let workspaces: any;

  const ownerUserId = 'user-1';
  const organizationId = 'org-1';

  const seed = (overrides: Partial<Workspace> = {}): Workspace => {
    const ws = {
      id: 'w-1',
      runnerId: 'r-1',
      ownerUserId,
      organizationId,
      cwd: '/work',
      isolation: RunnerIsolationTier.HOST,
      ttlAt: new Date(Date.now() - 1000),
      status: WorkspaceStatus.ACTIVE,
      closeReason: null,
      closedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Workspace;
    store.set(ws.id, ws);
    return ws;
  };

  /** A detached copy, which is what a real read gives a caller. */
  const detach = (ws: Workspace): Workspace =>
    ({ ...ws, closeReason: ws.closeReason ? { ...ws.closeReason } : null }) as Workspace;

  const matches = (ws: Workspace, where: Record<string, any>) => {
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === 'object' && '_value' in (v as any)) {
        const op = v as any;
        if (op._type === 'lessThanOrEqual') {
          const ts = (ws as any)[k] as Date | null;
          if (!ts || ts.getTime() > op._value.getTime()) return false;
          continue;
        }
        return false;
      }
      if ((ws as any)[k] !== v) return false;
    }
    return true;
  };

  beforeEach(async () => {
    store = new Map<string, Workspace>();
    workspaces = {
      find: jest.fn(async ({ where }: any) =>
        [...store.values()].filter((ws) => matches(ws, where)).map(detach),
      ),
      findOne: jest.fn(async ({ where }: any) => {
        const hit = [...store.values()].find((ws) => matches(ws, where));
        return hit ? detach(hit) : null;
      }),
      /** TypeORM's save of a loaded entity: every column, not just the changed ones. */
      save: jest.fn(async (ws: Workspace) => { store.set(ws.id, { ...ws }); return ws; }),
      /** A conditional UPDATE: nothing happens unless the criteria still match. */
      update: jest.fn(async (criteria: any, patch: any) => {
        let affected = 0;
        for (const ws of store.values()) {
          if (!matches(ws, criteria)) continue;
          Object.assign(ws, patch);
          affected += 1;
        }
        return { affected };
      }),
      createQueryBuilder: jest.fn(() => {
        let patch: Record<string, any> = {};
        let runnerIds: string[] = [];
        let requiredStatus: string | undefined;
        const qb: any = {
          update: () => qb,
          set: (values: Record<string, any>) => { patch = values; return qb; },
          where: (_c: string, p: any) => { runnerIds = p?.runnerIds ?? []; return qb; },
          andWhere: (_c: string, p: any) => { requiredStatus = p?.active; return qb; },
          execute: async () => {
            let affected = 0;
            for (const ws of store.values()) {
              if (!runnerIds.includes(ws.runnerId)) continue;
              if (requiredStatus && ws.status !== requiredStatus) continue;
              for (const [k, v] of Object.entries(patch)) {
                (ws as any)[k] =
                  typeof v === 'function' ? { kind: 'stranded', detail: ws.runnerId } : v;
              }
              affected += 1;
            }
            return { affected };
          },
        };
        return qb;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkspaceService,
        { provide: getRepositoryToken(Workspace), useValue: workspaces },
        { provide: getRepositoryToken(Runner), useValue: { find: jest.fn(), findOne: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(WorkspaceService);
  });

  it('a release that lost the race to the stranding fan-out leaves stranded standing', async () => {
    seed();

    // The stranding commits while the release call is between its read
    // and its write.
    workspaces.findOne.mockImplementationOnce(async ({ where }: any) => {
      const hit = [...store.values()].find((ws) => matches(ws, where));
      const snapshot = hit ? detach(hit) : null;
      await service.markStrandedForRunners(['r-1']);
      return snapshot;
    });

    const returned = await service.release('w-1', ownerUserId, organizationId);

    const row = store.get('w-1')!;
    expect(row.status).toBe(WorkspaceStatus.STRANDED);
    expect(row.closeReason).toEqual({ kind: 'stranded', detail: 'r-1' });
    // The caller is told what actually happened, not what it intended.
    expect(returned.status).toBe(WorkspaceStatus.STRANDED);
  });

  it('a TTL sweep that lost the race to the stranding fan-out does not overwrite it', async () => {
    seed();
    const candidates = await workspaces.find({
      where: { status: WorkspaceStatus.ACTIVE },
    });
    expect(candidates).toHaveLength(1);

    // The sweep selected while the workspace was still active; the
    // runner went offline before it got to the write.
    await service.markStrandedForRunners(['r-1']);
    const expired = await service.sweepExpired(new Date());

    expect(store.get('w-1')!.status).toBe(WorkspaceStatus.STRANDED);
    // And the sweep does not claim to have expired something it did not.
    expect(expired).toHaveLength(0);
  });

  it('a stranding fan-out that lost the race to a release does not overwrite it', async () => {
    seed();

    await service.release('w-1', ownerUserId, organizationId);
    const stranded = await service.markStrandedForRunners(['r-1']);

    expect(store.get('w-1')!.status).toBe(WorkspaceStatus.RELEASED);
    expect(stranded).toBe(0);
  });

  it('stranding reports the number of workspaces it actually stranded', async () => {
    seed({ id: 'w-1' });
    seed({ id: 'w-2' });
    seed({ id: 'w-3', status: WorkspaceStatus.RELEASED });

    expect(await service.markStrandedForRunners(['r-1'])).toBe(2);
    // Idempotent, which is what lets the self-heal retry it safely.
    expect(await service.markStrandedForRunners(['r-1'])).toBe(0);
  });

  it('the normal paths still record what they did', async () => {
    seed({ id: 'w-1', ttlAt: new Date(Date.now() - 5000) });
    const expired = await service.sweepExpired(new Date());
    expect(expired.map((w) => w.id)).toEqual(['w-1']);
    expect(store.get('w-1')!.status).toBe(WorkspaceStatus.EXPIRED);
    expect(store.get('w-1')!.closeReason!.kind).toBe('expired');

    seed({ id: 'w-2', ttlAt: null });
    const released = await service.release('w-2', ownerUserId, organizationId);
    expect(released.status).toBe(WorkspaceStatus.RELEASED);
    expect(store.get('w-2')!.closeReason).toEqual({ kind: 'released', detail: ownerUserId });
  });
});
