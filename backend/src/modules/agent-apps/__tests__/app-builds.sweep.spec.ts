import { FindOperator } from 'typeorm';

import { AppBuildsService, ARTIFACT_TTL_DAYS, BUILD_STALE_AFTER_MS } from '../app-builds.service';
import { AppBuild, BuildStatus } from '../../../entities/app-build.entity';

/**
 * The housekeeping half of the build service: the artifact sweep and the
 * reaper for builds whose worker never came back.
 *
 * The fake repository below evaluates a TypeORM `where` the way Postgres
 * would, three-valued logic included, because the bug these tests exist
 * for was a predicate that compiled, read correctly and matched nothing:
 * `Not(null)` renders as `"artifactKey" != NULL`, which is never true. A
 * fake that treated a FindOperator as an opaque token would have called
 * that sweep working.
 */
function matches(value: any, criterion: any): boolean {
  if (criterion instanceof FindOperator) {
    switch (criterion.type) {
      case 'not':
        // TypeORM renders Not(<operator>) as NOT(<that operator>), but
        // Not(<plain value>) as `col != :value` -- and in SQL any
        // comparison against NULL is NULL, which is not true.
        if (criterion.child) return !matches(value, criterion.child);
        if (criterion.value === null || criterion.value === undefined) return false;
        return value !== criterion.value;
      case 'isNull':
        return value === null || value === undefined;
      case 'lessThan':
        return value !== null && value !== undefined && value < criterion.value;
      case 'in':
        return (criterion.value as any[]).includes(value);
      default:
        throw new Error(`fake repository does not model the ${criterion.type} operator`);
    }
  }
  return value === criterion;
}

const rowMatches = (row: any, where: any): boolean =>
  (Array.isArray(where) ? where : [where]).some((clause) =>
    Object.entries(clause).every(([column, criterion]) => matches(row[column], criterion)),
  );

class FakeBuildRepository {
  /** Runs after find() has picked its rows, to simulate a concurrent write. */
  afterFind: (() => void) | null = null;

  constructor(public rows: Partial<AppBuild>[]) {}

  async find(options: any): Promise<any[]> {
    const hit = this.rows.filter((row) => rowMatches(row, options.where));
    const page = options.take ? hit.slice(0, options.take) : hit;
    // The caller holds these rows while it writes; a copy is what a real
    // SELECT hands back, so a later UPDATE re-reads the live row.
    const snapshot = page.map((row) => ({ ...row }));
    this.afterFind?.();
    return snapshot;
  }

  async save(row: any): Promise<any> {
    const live = this.rows.find((r) => r.id === row.id);
    if (live) Object.assign(live, row);
    return row;
  }

  async update(criteria: any, patch: any): Promise<{ affected: number }> {
    const hit = this.rows.filter((row) => rowMatches(row, criteria));
    for (const row of hit) Object.assign(row, patch);
    return { affected: hit.length };
  }
}

function makeService(rows: Partial<AppBuild>[]) {
  const builds = new FakeBuildRepository(rows);
  const deleted: string[] = [];
  const storage = {
    canPresign: false,
    delete: jest.fn(async (key: string) => {
      deleted.push(key);
    }),
  };
  const service = new AppBuildsService(
    builds as any,
    {} as any,
    {} as any,
    {} as any,
    storage as any,
  );
  return { service, builds, storage, deleted };
}

const HOUR = 60 * 60 * 1000;

describe('AppBuildsService housekeeping', () => {
  describe('sweepExpiredArtifacts', () => {
    it('deletes the file and clears the pointer for an expired artifact', async () => {
      const now = new Date('2026-03-01T00:00:00Z');
      const { service, builds, deleted } = makeService([
        {
          id: 'b-expired',
          status: BuildStatus.SUCCEEDED,
          artifactKey: 'app-builds/org/app/b-expired.zip',
          artifactExpiresAt: new Date(now.getTime() - ARTIFACT_TTL_DAYS * 24 * HOUR),
        },
      ]);

      await expect(service.sweepExpiredArtifacts(now)).resolves.toBe(1);
      expect(deleted).toEqual(['app-builds/org/app/b-expired.zip']);
      expect(builds.rows[0].artifactKey).toBeNull();
    });

    it('leaves artifacts that have not expired, and rows already swept', async () => {
      const now = new Date('2026-03-01T00:00:00Z');
      const { service, deleted } = makeService([
        {
          id: 'b-fresh',
          status: BuildStatus.SUCCEEDED,
          artifactKey: 'app-builds/org/app/b-fresh.zip',
          artifactExpiresAt: new Date(now.getTime() + 24 * HOUR),
        },
        {
          // Expired long ago, but its bytes are already gone. Nothing to
          // delete, and re-reporting it would inflate the sweep's count
          // for ever.
          id: 'b-already-swept',
          status: BuildStatus.SUCCEEDED,
          artifactKey: null,
          artifactExpiresAt: new Date(now.getTime() - 90 * 24 * HOUR),
        },
        {
          id: 'b-failed',
          status: BuildStatus.FAILED,
          artifactKey: null,
          artifactExpiresAt: new Date(now.getTime() - 90 * 24 * HOUR),
        },
      ]);

      await expect(service.sweepExpiredArtifacts(now)).resolves.toBe(0);
      expect(deleted).toEqual([]);
    });

    it('clears the pointer even when the file is already gone from storage', async () => {
      const now = new Date('2026-03-01T00:00:00Z');
      const { service, builds, storage } = makeService([
        {
          id: 'b-gone',
          status: BuildStatus.SUCCEEDED,
          artifactKey: 'app-builds/org/app/b-gone.zip',
          artifactExpiresAt: new Date(now.getTime() - HOUR),
        },
      ]);
      storage.delete.mockRejectedValueOnce(new Error('NoSuchKey'));

      await expect(service.sweepExpiredArtifacts(now)).resolves.toBe(1);
      expect(builds.rows[0].artifactKey).toBeNull();
    });
  });

  describe('failStaleBuilds', () => {
    it('fails builds whose worker never reported an outcome', async () => {
      const now = new Date('2026-03-01T00:00:00Z');
      const stale = new Date(now.getTime() - BUILD_STALE_AFTER_MS - HOUR);
      const { service, builds } = makeService([
        { id: 'b-queued', status: BuildStatus.QUEUED, createdAt: stale },
        { id: 'b-running', status: BuildStatus.RUNNING, createdAt: stale },
      ]);

      await expect(service.failStaleBuilds(now)).resolves.toBe(2);
      for (const row of builds.rows) {
        expect(row.status).toBe(BuildStatus.FAILED);
        expect(row.finishedAt).toEqual(now);
        expect(row.error).toMatch(/never finished/);
      }
    });

    it('leaves builds that are still inside the window, and finished ones', async () => {
      const now = new Date('2026-03-01T00:00:00Z');
      const { service, builds } = makeService([
        {
          id: 'b-young',
          status: BuildStatus.RUNNING,
          createdAt: new Date(now.getTime() - BUILD_STALE_AFTER_MS + HOUR),
        },
        {
          id: 'b-done',
          status: BuildStatus.SUCCEEDED,
          createdAt: new Date(now.getTime() - 30 * 24 * HOUR),
        },
      ]);

      await expect(service.failStaleBuilds(now)).resolves.toBe(0);
      expect(builds.rows.map((r) => r.status)).toEqual([
        BuildStatus.RUNNING,
        BuildStatus.SUCCEEDED,
      ]);
    });

    it('does not overwrite a build that finished between the read and the write', async () => {
      const now = new Date('2026-03-01T00:00:00Z');
      const { service, builds } = makeService([
        {
          id: 'b-slow',
          status: BuildStatus.RUNNING,
          createdAt: new Date(now.getTime() - BUILD_STALE_AFTER_MS - HOUR),
        },
      ]);
      // The toolchain finishes just after the sweep selected this row.
      builds.afterFind = () => {
        builds.rows[0].status = BuildStatus.SUCCEEDED;
        builds.afterFind = null;
      };

      await expect(service.failStaleBuilds(now)).resolves.toBe(0);
      expect(builds.rows[0].status).toBe(BuildStatus.SUCCEEDED);
      expect(builds.rows[0].error).toBeUndefined();
    });
  });
});
