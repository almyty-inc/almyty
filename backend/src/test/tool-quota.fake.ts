import { EntityManager } from 'typeorm';

/**
 * EntityManager stand-in for specs that insert tools but are not about the
 * tool quota (modules/tools/tool-quota.ts): the organization has no
 * `maxTools`, and COUNT answers 0, so every insert fits. Hang it on the
 * mocked repository as `manager`. Specs about the quota build their own
 * (see modules/tools/__tests__/tool-quota-enforced.spec.ts).
 *
 * Inserts run through `withToolQuota`, which opens a transaction and
 * writes through `tx.getRepository(Tool)`. Pass the mocked repository as
 * `owner` and those writes land on its `save` / `create` mocks, so a spec
 * can keep asserting on them. From an object literal handed to Nest as
 * `useValue`, a getter does that: `get manager() { return
 * unlimitedToolQuotaManager(this); }`.
 */
export function unlimitedToolQuotaManager(owner?: object): EntityManager {
  const quotaReads: Record<string, unknown> = {
    findOne: async () => ({ settings: {} }),
    count: async () => 0,
  };
  const repository = () =>
    new Proxy(quotaReads, {
      get: (target, prop: string) =>
        prop in target ? target[prop] : (owner as Record<string, unknown> | undefined)?.[prop],
    });
  const tx = {
    queryRunner: { isTransactionActive: true },
    query: async () => [],
    getRepository: repository,
  };
  return {
    getRepository: repository,
    // Entity-level lookups other code on the same manager makes (e.g. the
    // agent a gateway serves) find nothing, as when `manager` was absent.
    findOne: async () => null,
    transaction: async (work: (tx: EntityManager) => unknown) => work(tx as unknown as EntityManager),
  } as unknown as EntityManager;
}
/**
 * The same stand-in for any per-organization quota (gateways too): the
 * organization carries no limit, so nothing is counted or locked, and
 * writes on the transaction land on `owner`'s mocks.
 */
export const unlimitedQuotaManager = unlimitedToolQuotaManager;