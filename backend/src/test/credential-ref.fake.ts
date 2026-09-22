import { Credential } from '../entities/credential.entity';
import { CredentialRefResolver, ConnectionUsePolicy } from '../modules/credentials/credential-ref.resolver';
import { EnvelopeCryptoService } from '../modules/kms/envelope-crypto.service';
import { makeEnvelopeCryptoMock } from './envelope-crypto.mock';

/**
 * A CredentialRefResolver over an in-memory credentials table, for unit
 * specs of the consumers (LLM providers, MCP sources, channel
 * installations, APIs). Rows are real Credential instances so the
 * entity's own encryption and decryption run unchanged.
 */
export interface FakeCredentialStore {
  resolver: CredentialRefResolver;
  rows: Credential[];
  repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };
  /** Insert a row directly (already-encrypted or plaintext config). */
  seed(row: Partial<Credential>): Credential;
}

let counter = 0;

export function makeCredentialRefFake(policy?: ConnectionUsePolicy, envelope?: EnvelopeCryptoService): FakeCredentialStore {
  const rows: Credential[] = [];
  const matches = (row: Credential, where: Record<string, any>) =>
    Object.entries(where ?? {}).every(([k, v]) => v === undefined || (row as any)[k] === v);
  const repo = {
    findOne: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
    find: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matches(r, where ?? {}))),
    create: jest.fn((data: any) => Object.assign(new Credential(), data)),
    save: jest.fn(async (row: Credential) => {
      if (!row.id) row.id = `cred-${++counter}`;
      if (!rows.includes(row)) rows.push(row);
      return row;
    }),
    /**
     * Scoped column update: writes ONLY the columns in the patch, and
     * only to rows matching the criteria. Modelled rather than stubbed,
     * because the difference between this and save() is the whole
     * reason recordHealth stopped reverting a rotated secret.
     */
    update: jest.fn(async (criteria: any, patch: Record<string, any>) => {
      let affected = 0;
      for (const row of rows) {
        if (!matches(row, criteria)) continue;
        for (const [k, v] of Object.entries(patch)) (row as any)[k] = v;
        affected += 1;
      }
      return { affected };
    }),
    remove: jest.fn(async (row: Credential) => {
      const at = rows.indexOf(row);
      if (at >= 0) rows.splice(at, 1);
      return row;
    }),
  };
  const resolver = new CredentialRefResolver(repo as any, envelope ?? makeEnvelopeCryptoMock(), policy);
  const seed = (row: Partial<Credential>): Credential => {
    const entity = Object.assign(new Credential(), { isActive: true, config: {}, metadata: null, ...row });
    if (!entity.id) entity.id = `cred-${++counter}`;
    rows.push(entity);
    return entity;
  };
  return { resolver, rows, repo, seed };
}
