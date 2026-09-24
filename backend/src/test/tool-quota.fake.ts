import { EntityManager } from 'typeorm';

/**
 * EntityManager stand-in for specs that insert tools but are not about the
 * tool quota (modules/tools/tool-quota.ts): the organization has no
 * `maxTools`, and COUNT answers 0, so every insert fits. Hang it on the
 * mocked repository as `manager`. Specs about the quota build their own
 * (see modules/tools/__tests__/tool-quota-enforced.spec.ts).
 */
export function unlimitedToolQuotaManager(): EntityManager {
  return {
    getRepository: () => ({
      findOne: async () => ({ settings: {} }),
      count: async () => 0,
    }),
  } as unknown as EntityManager;
}
