import { encryptField } from '../../../../common/security/field-crypto';
import { ModelDeployment } from '../../../../entities/model-deployment.entity';
import { FakeRepository, UnmodelledQueryError, fakeRepository } from '../../../../test/fake-repository';

/**
 * In-memory stand-ins for the gate scenarios: the shared truthful
 * repository (rows copied in and out, every `where` evaluated, `update`
 * a real compare-and-set) plus the one query builder the reconcile loop
 * uses, an audit sink that keeps every row, and an envelope that encrypts
 * with the platform key so getDecryptedProviderConfig round-trips.
 *
 * The double this replaces handed out the stored object itself, so a
 * card the processor flipped in memory was "saved" whether or not
 * `models.save()` ran; and its claim builder took the row id and the
 * `deploying` parameter from the call and ignored the SQL, so the claim's
 * WHERE could be rewritten to match every row, in any state, with every
 * gate green.
 */
export function ensureTestKey(): void {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key-32-bytes-minimum-len';
}

/**
 * The clauses of the deploy claim this builder evaluates, by their exact
 * SQL. Anything else throws: a claim whose predicate changed must fail
 * here rather than be read as the old one.
 */
const CLAIM_CLAUSES: Record<string, (row: any, params: Record<string, any>) => boolean> = {
  'id = :id': (row, p) => row.id === p.id,
  '(state != :deploying OR "lastReconcileAt" IS NULL OR "lastReconcileAt" < :staleClaim)': (row, p) =>
    row.state !== p.deploying || row.lastReconcileAt == null || new Date(row.lastReconcileAt) < p.staleClaim,
};

export interface FakeRepo<T extends { id?: string }> extends FakeRepository<T> {
  createQueryBuilder: jest.Mock;
  /** The stored row, as a copy. Change it through the repository. */
  get(id: string): T;
}

export function fakeRepo<T extends { id?: string }>(factory: () => T, seed: T[] = []): FakeRepo<T> {
  const repo = fakeRepository<T>({ seed, make: factory });
  let seq = 0;
  const innerSave = repo.save.getMockImplementation()!;
  // Ids read like the old fake's (`stub-1`), which the gate specs print.
  repo.save.mockImplementation(async (entity: any) => {
    for (const e of Array.isArray(entity) ? entity : [entity]) {
      if (e.id == null) e.id = `${e.providerType ?? 'row'}-${++seq}`;
    }
    return innerSave(entity);
  });
  return Object.assign(repo, {
    /**
     * `UPDATE ... SET ... WHERE <clauses>` evaluated against every row,
     * with the true number of rows it touched.
     */
    createQueryBuilder: jest.fn(() => {
      let patch: Record<string, any> | undefined;
      const clauses: Array<{ sql: string; params: Record<string, any> }> = [];
      const qb: any = {
        update: () => qb,
        set: (values: Record<string, any>) => { patch = values; return qb; },
        where: (sql: string, params: Record<string, any> = {}) => { clauses.push({ sql, params }); return qb; },
        andWhere: (sql: string, params: Record<string, any> = {}) => { clauses.push({ sql, params }); return qb; },
        execute: async () => {
          if (!patch || clauses.length === 0) throw new UnmodelledQueryError('an UPDATE without SET or WHERE');
          const params = Object.assign({}, ...clauses.map((c) => c.params));
          const predicates = clauses.map(({ sql }) => {
            const p = CLAIM_CLAUSES[sql.replace(/\s+/g, ' ').trim()];
            if (!p) throw new UnmodelledQueryError(`the clause "${sql}" is not modelled`);
            return p;
          });
          const hits = repo.rows().filter((row) => predicates.every((p) => p(row, params)));
          for (const row of hits) repo.seed(Object.assign(row, patch));
          return { affected: hits.length, raw: [] };
        },
      };
      return qb;
    }),
    get(id: string): T {
      const row = repo.row(id);
      if (!row) throw new Error(`no row ${id}`);
      return row;
    },
  });
}

export function fakeAudit() {
  const rows: any[] = [];
  return { rows, log: jest.fn(async (row: any) => { rows.push(row); return row; }) };
}

export const fakeEnvelope = {
  warmOrg: jest.fn(async () => undefined),
  encryptForOrg: jest.fn(async (_org: string, plaintext: string) => encryptField(plaintext)),
};

export const fakeQueue = () => ({ add: jest.fn(async () => undefined), getRepeatableJobs: jest.fn(async () => []), removeRepeatableByKey: jest.fn() });

export const newDeployment = () => new ModelDeployment();

/**
 * The org's registry connection as the deployments service sees it: for an
 * s3:// version, credentialsFor merges these keys into what the adapter
 * gets. They never come from providerConfig or the environment.
 */
export const REGISTRY_KEYS = { registryAccessKeyId: 'AKIA-REGISTRY', registrySecretAccessKey: 'registry-secret-key', registryEndpoint: 'https://minio.local', registryRegion: 'eu-central-1', registryBucket: 'almyty-models' };

export const fakeRegistry = () => ({ adapterCredentialsFor: jest.fn(async (_org: string) => ({ ...REGISTRY_KEYS })) });
