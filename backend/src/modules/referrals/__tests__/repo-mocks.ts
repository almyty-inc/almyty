import { fakeRepository, FakeRepository } from '../../../test/fake-repository';

/**
 * The referrals specs' tables: the shared truthful repository, so the
 * services get detached copies and every write they rely on has to reach
 * the table. The earlier mock stored and handed back the caller's own
 * object and left `"rewardDays" + n` unevaluated, so the reward counter
 * increment and the plan/bank saves could each be deleted with the
 * referrals suites green.
 *
 * `patch` edits a stored row directly -- the test standing in for another
 * writer, an operator, or a concurrent request.
 */
export type ReferralsRepo = FakeRepository<any> & {
  patch(id: string, changes: Record<string, any>): any;
};

export function makeRepo(prefix: string, seed: any[] = []): ReferralsRepo {
  const repo = fakeRepository<any>({ seed, idPrefix: prefix });
  return Object.assign(repo, {
    patch: (id: string, changes: Record<string, any>) => {
      const row = repo.row(id);
      if (!row) throw new Error(`no ${prefix} row ${id}`);
      return repo.seed({ ...row, ...changes });
    },
  });
}

export function makeAudit() {
  return { log: jest.fn().mockResolvedValue(null) };
}
