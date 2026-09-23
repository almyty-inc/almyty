/**
 * The user's selected organization, reachable from outside React.
 *
 * Two places need it and neither can hold a reference to the org store:
 * the axios interceptors in `lib/api.ts` (the store imports that module,
 * so importing it back is a cycle) and the auth store (which must be able
 * to drop the selection without reaching into the persist middleware's
 * storage format).
 *
 * Deliberately import-free, so both sides can depend on it.
 *
 * The part that matters: clearing the selection means clearing the LIVE
 * Zustand state, not just the persisted copy. `localStorage.removeItem`
 * on its own leaves `currentOrganization` sitting in memory, and the very
 * next `set()` on that store flushes it straight back through the persist
 * middleware — so the "cleared" id reappears under the key the request
 * interceptor reads, and `initializeFromUser` still compares new logins
 * against the previous session's org. That is what turned a stale
 * organization id into a bounce back to the login page a moment after
 * signing in.
 */

/** Where the persist middleware writes the org store. */
export const ORG_STORE_KEY = 'almyty-org-store'

type Clearer = () => void

/** Set by `store/organization.ts` when the store is created. */
let clearLiveSelection: Clearer | null = null

export function registerOrganizationSelectionClearer(clearer: Clearer): void {
  clearLiveSelection = clearer
}

/**
 * The selected org id, read from the persisted copy.
 *
 * Reads storage rather than the store so it also answers on the very
 * first request of a cold page load, before any component has mounted.
 */
export function readCurrentOrgId(): string | null {
  try {
    const raw = localStorage.getItem(ORG_STORE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: { currentOrganization?: { id?: string } } }
    return parsed?.state?.currentOrganization?.id ?? null
  } catch {
    return null
  }
}

/** Drop the selection from the live store AND from storage, in that order. */
export function clearOrganizationSelection(): void {
  try {
    clearLiveSelection?.()
  } catch {
    // A store that cannot be reset must not stop us clearing storage.
  }
  try {
    localStorage.removeItem(ORG_STORE_KEY)
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
}

/**
 * Marker for the one page reload a stale organization context is allowed
 * to cause. It has to outlive the reload it causes — the module
 * re-evaluates, so a plain variable would let a server that keeps
 * refusing reload forever.
 */
export const ORG_CONTEXT_RECOVERY_KEY = 'almyty-org-context-recovered'

/**
 * Is this refusal the one the client can fix by itself?
 *
 * `X-Organization-Id` naming an organization the caller cannot act in is
 * stale client state, not an invalid session, and the backend says so
 * with a 403 carrying ORGANIZATION_CONTEXT_INVALID rather than the 401
 * it used to send. That distinction is the whole fix: a 401 sent this
 * down the sign-out path below, so one stale org id read to the user as
 * being signed out seconds after signing in.
 *
 * Pure and exported for the same reason as shouldRetryRequest in
 * lib/api.ts: the interceptor itself cannot be exercised under the
 * global axios mock.
 */
export function isStaleOrganizationContext(
  status: number | undefined,
  code: unknown,
): boolean {
  return status === 403 && code === 'ORGANIZATION_CONTEXT_INVALID'
}

let orgContextRecoveryUsed: boolean | null = null

function orgContextRecoveryAlreadyUsed(): boolean {
  if (orgContextRecoveryUsed === null) {
    try {
      orgContextRecoveryUsed = sessionStorage.getItem(ORG_CONTEXT_RECOVERY_KEY) !== null
    } catch {
      orgContextRecoveryUsed = false
    }
  }
  return orgContextRecoveryUsed
}

/**
 * Rearm the one-reload budget. Called from an explicit sign-in only.
 *
 * Deliberately NOT called on every successful response. Arming there
 * reads well — "the session is answering again" — but it re-opens the
 * reload loop the 401 branch in lib/api.ts already carries a warning
 * about: a 200 on /auth/profile followed by another refused
 * organization would reload, and so on, several times a second. A
 * sign-in is a deliberate act by a person, so it cannot spin.
 */
export function armOrganizationContextRecovery(): void {
  if (orgContextRecoveryUsed === false) return
  orgContextRecoveryUsed = false
  try {
    sessionStorage.removeItem(ORG_CONTEXT_RECOVERY_KEY)
  } catch {
    // Storage can be unavailable; the in-memory flag still holds.
  }
}

/**
 * Drop the refused organization selection and let the app re-derive it.
 *
 * The selection goes whether or not we reload — it is the thing the
 * server refused, and leaving it in place means every later request
 * carries it too. The reload is what gets the user a working page
 * without making them sign in again; it is capped at one per tab.
 *
 * Returns whether it reloaded, so tests can tell the two apart.
 */
export function recoverFromStaleOrganizationContext(): boolean {
  clearOrganizationSelection()
  if (orgContextRecoveryAlreadyUsed()) return false
  orgContextRecoveryUsed = true
  try {
    sessionStorage.setItem(ORG_CONTEXT_RECOVERY_KEY, '1')
  } catch {
    // Without storage we still reload once per page load.
  }
  if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
    window.location.reload()
  }
  return true
}

