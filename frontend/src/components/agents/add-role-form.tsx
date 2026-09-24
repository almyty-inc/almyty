import { useState, type FormEvent } from 'react'

import { Input } from '@/components/ui/input'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

/**
 * Creating a role.
 *
 * The Execution tab shipped without this, so a new agent had no roles, no
 * way to make one, and therefore every strategy permanently disabled for
 * want of slots. The picker looked finished and could not be used.
 *
 * A role is named by its key, which is what a strategy's slot matches, so
 * the key is offered from the slots the built-in shapes actually ask for
 * rather than left as free text nobody can guess right.
 */
const SUGGESTED = ['principal', 'drafter', 'verifier', 'explorer', 'summariser', 'orchestrator', 'panelist_one', 'panelist_two', 'panelist_three']

export interface AddRoleFormProps {
  /** Keys already taken on this agent, so a duplicate is refused before the request. */
  existingKeys: string[]
  /** Slots the chosen shapes need and this agent has not filled. */
  neededKeys?: string[]
  onCreate: (role: { key: string; displayName: string }) => void
  onCancel: () => void
  saving?: boolean
  error?: string
}

/**
 * Inline, inside the Roles card it adds to: a role is two short fields,
 * and a dialog over the list hid the roles you were trying not to
 * duplicate.
 */
export function AddRoleForm({ existingKeys, neededKeys = [], onCreate, onCancel, saving, error }: AddRoleFormProps) {
  const [key, setKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  // Typed-in work asks before a navigation throws it away. Cancel unmounts
  // the form and submitting empties the fields, so neither asks.
  const guard = useLeaveGuard(key !== '' || displayName !== '')

  const trimmed = key.trim()
  const duplicate = existingKeys.includes(trimmed)
  const malformed = !!trimmed && !/^[a-z][a-z0-9_]*$/.test(trimmed)
  const canCreate = !!trimmed && !duplicate && !malformed && !saving

  // Needed first: those are the ones that unlock a strategy right now.
  const offered = [...neededKeys, ...SUGGESTED.filter((s) => !neededKeys.includes(s))].filter((s) => !existingKeys.includes(s))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!canCreate) return
    onCreate({ key: trimmed, displayName: displayName.trim() || trimmed })
    setKey('')
    setDisplayName('')
  }

  return (
    <>
      <form
        data-testid="add-role-form"
        aria-label="Add a role"
        noValidate
        onSubmit={submit}
        className="mb-4 space-y-4 rounded-lg border bg-muted/30 p-4"
      >
        <p className="text-sm text-muted-foreground">
          A role is a job in this agent, like principal or verifier. A strategy fills its slots from these, and you change
          model by rebinding a role rather than editing the graph.
        </p>

        <Field
          id="role-key"
          label="Key"
          required
          error={
            duplicate ? (
              <span data-testid="role-key-duplicate">This agent already has a role called {trimmed}.</span>
            ) : malformed ? (
              <span data-testid="role-key-malformed">
                Lowercase letters, digits and underscores, starting with a letter — strategies match slots by this name.
              </span>
            ) : undefined
          }
        >
          <Input value={key} placeholder="principal" autoFocus onChange={(e) => setKey(e.target.value)} />
        </Field>

        {offered.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground">
              {neededKeys.length > 0 ? 'Slots your strategies need:' : 'Common roles:'}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {offered.slice(0, 8).map((slot) => (
                <button
                  key={slot}
                  type="button"
                  data-testid={`suggest-${slot}`}
                  onClick={() => setKey(slot)}
                  className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  {slot}
                </button>
              ))}
            </div>
          </div>
        )}

        <Field id="role-name" label="Name (optional)">
          <Input value={displayName} placeholder={trimmed || 'Principal'} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>

        {error && (
          <p data-testid="add-role-error" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <InlineFormActions
          onCancel={onCancel}
          submitLabel={saving ? 'Adding...' : 'Add role'}
          submitting={saving}
          submitDisabled={!canCreate}
        />
      </form>
      {guard.element}
    </>
  )
}