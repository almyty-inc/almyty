/* Sensitive-value clipboard helpers.
 *
 * Background: the product has 19+ `navigator.clipboard.writeText` call
 * sites, and about a third of them copy values that should not live
 * on a clipboard longer than necessary — API keys, bearer tokens,
 * gateway auth credentials, webhook URLs with embedded secrets.
 *
 * The old pattern raised a plain success toast ("Copied!") which
 * doesn't hint to the user that they just put a secret on the system
 * clipboard. On a shared workstation the next paste-anywhere is a
 * leak vector.
 *
 * The `useCopySensitive` hook wraps writeText, raises a WARNING-tier
 * toast (yellow, aria-live=assertive per Batch A), and reminds the
 * user to clear their clipboard. Non-sensitive copies (public URLs,
 * agent names, output JSON) should keep using the existing
 * `success` notification and a raw writeText — don't over-apply this
 * helper or the warnings stop meaning anything.
 */
import { useCallback } from 'react'

import { useNotifications } from '@/store/app'

export function useCopySensitive() {
  const { warning, error } = useNotifications()

  return useCallback(
    async (value: string, label: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(value)
        warning(
          `${label} copied`,
          'This value is sensitive. Clear your clipboard when you are done — especially on shared devices.',
        )
      } catch {
        error(`Failed to copy ${label}`, 'Clipboard access was denied by the browser.')
      }
    },
    [warning, error],
  )
}

/**
 * Non-sensitive counterpart: same writeText + toast plumbing, but a plain
 * success toast. For public values (share links, names, output JSON) where
 * the warning-tier toast above would dilute its meaning.
 */
export function useCopy() {
  const { success, error } = useNotifications()

  return useCallback(
    async (value: string, label: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(value)
        success(`${label} copied`)
      } catch {
        error(`Failed to copy ${label}`, 'Clipboard access was denied by the browser.')
      }
    },
    [success, error],
  )
}
