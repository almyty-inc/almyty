import { encryptField } from '../../../../common/security/field-crypto';
import { ModelDeployment } from '../../../../entities/model-deployment.entity';

/**
 * In-memory stand-ins for the gate scenarios: enough of a TypeORM
 * repository (create/save/find/findOne by equality) to drive the real
 * ModelDeploymentsService and ModelDeploymentsProcessor end to end, an
 * audit sink that keeps every row, and an envelope that encrypts with the
 * platform key so getDecryptedProviderConfig round-trips.
 */
export function ensureTestKey(): void {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key-32-bytes-minimum-len';
}

function matches(row: any, where: Record<string, any> | undefined): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (v && typeof v === 'object' && '_type' in v && Array.isArray(v._value)) return v._value.includes(row[k]);
    return row[k] === v;
  });
}

export interface FakeRepo<T extends { id?: string }> {
  rows: Map<string, T>;
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  get(id: string): T;
}

export function fakeRepo<T extends { id?: string }>(factory: () => T, seed: T[] = []): FakeRepo<T> {
  const rows = new Map<string, T>();
  let seq = 0;
  for (const r of seed) rows.set(r.id!, r);
  return {
    rows,
    create: jest.fn((partial: Partial<T>) => Object.assign(factory(), partial)),
    save: jest.fn(async (row: T) => {
      if (!row.id) (row as any).id = `${(row as any).providerType ?? 'row'}-${++seq}`;
      rows.set(row.id!, row);
      return row;
    }),
    find: jest.fn(async (opts?: { where?: Record<string, any> }) => [...rows.values()].filter((r) => matches(r, opts?.where))),
    findOne: jest.fn(async (opts?: { where?: Record<string, any> }) => [...rows.values()].find((r) => matches(r, opts?.where)) ?? null),
    get(id: string) {
      const row = rows.get(id);
      if (!row) throw new Error(`no row ${id}`);
      return row;
    },
  };
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
