import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Regression test for the bug where `initializeFromUser` short-circuited
 * on `isInitialized=true` and never refreshed the org list when a
 * different user signed in on the same browser. The first call after
 * user-A login set `isInitialized=true`; user-A's `currentOrganization`
 * was persisted via Zustand's persist middleware; user-B then logged in
 * on the same browser, but `initializeFromUser(userB)` returned at the
 * guard. The request interceptor kept stamping user-A's orgId into the
 * `X-Organization-Id` header and every authenticated call 401'd with
 * "Not a member of the requested organization".
 */

vi.mock('@/lib/api', () => ({
  organizationsApi: { getAll: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}))

const makeLocalStorage = () => {
  const store = new Map<string, string>()
  return {
    store,
    getItem: vi.fn((k: string) => store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => store.set(k, v)),
    removeItem: vi.fn((k: string) => store.delete(k)),
    clear: vi.fn(() => store.clear()),
    key: vi.fn((i: number) => Array.from(store.keys())[i] ?? null),
    get length() {
      return store.size
    },
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: makeLocalStorage(),
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

function makeUser(userId: string, orgId: string, orgName: string) {
  return {
    id: userId,
    email: `${userId}@example.com`,
    organizationMemberships: [
      {
        role: 'owner',
        organization: { id: orgId, name: orgName, slug: orgName },
      },
    ],
  } as any
}

describe('organization store initializeFromUser', () => {
  it('switches currentOrganization when a different user logs in on the same browser', async () => {
    const { useOrganizationStore } = await import('../organization')

    useOrganizationStore.getState().initializeFromUser(makeUser('u1', 'org-A', 'Org A'))
    expect(useOrganizationStore.getState().currentOrganization?.id).toBe('org-A')

    // Second login, different user with NO membership in org-A.
    useOrganizationStore.getState().initializeFromUser(makeUser('u2', 'org-B', 'Org B'))

    expect(useOrganizationStore.getState().currentOrganization?.id).toBe('org-B')
    expect(
      useOrganizationStore.getState().organizations.map((o) => o.id),
    ).toEqual(['org-B'])
  })

  it('preserves currentOrganization across re-init when the user is still a member', async () => {
    const { useOrganizationStore } = await import('../organization')

    // Seed: user has two orgs, currentOrganization is the second.
    const user = {
      id: 'u1',
      email: 'u1@example.com',
      organizationMemberships: [
        { role: 'member', organization: { id: 'org-A', name: 'A', slug: 'a' } },
        { role: 'owner', organization: { id: 'org-B', name: 'B', slug: 'b' } },
      ],
    } as any

    useOrganizationStore.getState().initializeFromUser(user)
    useOrganizationStore.getState().setCurrentOrganization({
      id: 'org-B', name: 'B', slug: 'b', members: [],
    } as any)

    expect(useOrganizationStore.getState().currentOrganization?.id).toBe('org-B')

    // Re-init with the same user (simulating checkAuth on refresh).
    useOrganizationStore.getState().initializeFromUser(user)

    // Selection survives because user is still a member of org-B.
    expect(useOrganizationStore.getState().currentOrganization?.id).toBe('org-B')
  })

  it('falls back to the first membership when the persisted current is no longer in the user\'s memberships', async () => {
    const { useOrganizationStore } = await import('../organization')

    useOrganizationStore.getState().initializeFromUser(makeUser('u1', 'org-A', 'Org A'))
    expect(useOrganizationStore.getState().currentOrganization?.id).toBe('org-A')

    // User now belongs to org-C only — org-A is no longer in their memberships.
    useOrganizationStore.getState().initializeFromUser(makeUser('u1', 'org-C', 'Org C'))

    expect(useOrganizationStore.getState().currentOrganization?.id).toBe('org-C')
  })
})
