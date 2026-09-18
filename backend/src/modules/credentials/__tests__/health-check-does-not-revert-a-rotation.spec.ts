import { Credential, CredentialType } from '../../../entities/credential.entity';
import { encryptField, isEncrypted } from '../../../common/security/field-crypto';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { CredentialRefResolver } from '../credential-ref.resolver';

/**
 * A health probe must never carry a credential's secret with it.
 *
 * `recordHealth` is called from the LLM provider health check, which
 * runs a second after every provider update and again on a cron sweep.
 * It reads the row at the top and writes at the bottom, and the
 * encrypted API key sits in `config` in between. A save() of the loaded
 * entity writes back every column whose in-memory value differs from
 * the row's, so a key the user rotated inside that window was
 * overwritten with the old ciphertext — and because the entity does no
 * decryption on load, the stale value is valid ciphertext and the
 * revert is completely silent. A key rotated because it leaked would be
 * quietly reinstated by a background job.
 *
 * The fake below models that write-back rather than stubbing it:
 * `findOne` hands out a DETACHED COPY (as a real read does) and `save`
 * copies every column of that copy onto the stored row. A fake whose
 * findOne returned the live object would show no revert no matter how
 * the service was written, and this defect would stay invisible.
 *
 * Everything here is ciphertext: what is asserted is that the bytes in
 * the column are the ones the rotation committed, never what they
 * decrypt to.
 */
function makeStore() {
  const stored: Credential[] = [];
  const matches = (row: Credential, where: Record<string, any>) =>
    Object.entries(where ?? {}).every(([k, v]) => v === undefined || (row as any)[k] === v);

  const repo = {
    findOne: jest.fn(async ({ where }: any) => {
      const row = stored.find((r) => matches(r, where));
      // A detached copy, which is what a real read gives you.
      return row ? Object.assign(new Credential(), JSON.parse(JSON.stringify(row))) : null;
    }),
    find: jest.fn(async () => stored.map((r) => r)),
    create: jest.fn((data: any) => Object.assign(new Credential(), data)),
    /** TypeORM's save of a loaded entity: every column, not just the changed ones. */
    save: jest.fn(async (entity: Credential) => {
      const row = stored.find((r) => r.id === entity.id);
      if (row) Object.assign(row, entity);
      else stored.push(entity);
      return entity;
    }),
    /** A scoped UPDATE: only the columns in the patch. */
    update: jest.fn(async (criteria: any, patch: Record<string, any>) => {
      let affected = 0;
      for (const row of stored) {
        if (!matches(row, criteria)) continue;
        for (const [k, v] of Object.entries(patch)) (row as any)[k] = v;
        affected += 1;
      }
      return { affected };
    }),
    remove: jest.fn(),
  };

  const resolver = new CredentialRefResolver(repo as any, makeEnvelopeCryptoMock());
  const seed = (row: Partial<Credential>) => {
    const entity = Object.assign(new Credential(), {
      id: `cred-${stored.length + 1}`,
      isActive: true,
      config: {},
      metadata: null,
      ...row,
    });
    stored.push(entity);
    return entity;
  };
  const live = (id: string) => stored.find((r) => r.id === id)!;
  return { resolver, repo, seed, live };
}

describe('recordHealth', () => {
  const LEAKED = () => encryptField('sk-the-one-that-leaked');
  const REPLACEMENT = () => encryptField('sk-the-replacement');

  it('does not write the old secret back over a rotation that landed mid-probe', async () => {
    const store = makeStore();
    const seeded = store.seed({
      organizationId: 'org-1',
      type: CredentialType.API_KEY,
      config: { apiKey: LEAKED(), baseUrl: 'https://api.example.com' },
      healthStatus: 'unknown',
    });

    // The sweep's read of this credential happened BEFORE the rotation,
    // which is the whole sequence: the probe is a network call to the
    // provider with the row already in hand, and the verdict is written
    // when it returns. Hand the probe that pre-rotation snapshot.
    const staleSnapshot = await store.repo.findOne({
      where: { id: seeded.id, organizationId: 'org-1' },
    });
    expect(staleSnapshot.config.apiKey).toBe(seeded.config.apiKey);
    store.repo.findOne.mockResolvedValueOnce(staleSnapshot);

    // The user rotates the key because it leaked, and it commits.
    const rotated = REPLACEMENT();
    store.live(seeded.id).config = { ...store.live(seeded.id).config, apiKey: rotated };

    // Only now does the probe record its verdict.
    await store.resolver.recordHealth('org-1', seeded.id, 'valid', null);

    const row = store.live(seeded.id);
    expect(row.config.apiKey).toBe(rotated);
    expect(isEncrypted(row.config.apiKey)).toBe(true);
    expect(row.healthStatus).toBe('valid');
    expect(row.healthCheckedAt).toBeInstanceOf(Date);
  });

  it('writes only the four health columns', async () => {
    const store = makeStore();
    const seeded = store.seed({
      organizationId: 'org-1',
      type: CredentialType.API_KEY,
      config: { apiKey: LEAKED() },
    });

    await store.resolver.recordHealth('org-1', seeded.id, 'failed', 'upstream said 401');

    expect(store.repo.save).not.toHaveBeenCalled();
    const [, patch] = store.repo.update.mock.calls[0];
    expect(Object.keys(patch).sort()).toEqual([
      'healthCheckedAt',
      'healthError',
      'healthStatus',
      'lastUsedAt',
    ]);
    expect(store.live(seeded.id).healthError).toBe('upstream said 401');
  });

  it('stays scoped to the org, so a probe cannot touch a foreign credential', async () => {
    const store = makeStore();
    const foreign = store.seed({
      organizationId: 'org-2',
      type: CredentialType.API_KEY,
      config: { apiKey: LEAKED() },
      healthStatus: 'unknown',
    });

    await store.resolver.recordHealth('org-1', foreign.id, 'failed', 'nope');

    expect(store.live(foreign.id).healthStatus).toBe('unknown');
  });

  it('is a no-op without a credential id', async () => {
    const store = makeStore();
    await store.resolver.recordHealth('org-1', null, 'valid');
    expect(store.repo.update).not.toHaveBeenCalled();
    expect(store.repo.save).not.toHaveBeenCalled();
  });
});
