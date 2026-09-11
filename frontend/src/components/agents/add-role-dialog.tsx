import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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

export interface AddRoleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Keys already taken on this agent, so a duplicate is refused before the request. */
  existingKeys: string[]
  /** Slots the chosen shapes need and this agent has not filled. */
  neededKeys?: string[]
  onCreate: (role: { key: string; displayName: string }) => void
  saving?: boolean
  error?: string
}

export function AddRoleDialog({ open, onOpenChange, existingKeys, neededKeys = [], onCreate, saving, error }: AddRoleDialogProps) {
  const [key, setKey] = useState('')
  const [displayName, setDisplayName] = useState('')

  const trimmed = key.trim()
  const duplicate = existingKeys.includes(trimmed)
  const malformed = !!trimmed && !/^[a-z][a-z0-9_]*$/.test(trimmed)
  const canCreate = !!trimmed && !duplicate && !malformed && !saving

  // Needed first: those are the ones that unlock a strategy right now.
  const offered = [...neededKeys, ...SUGGESTED.filter((s) => !neededKeys.includes(s))].filter((s) => !existingKeys.includes(s))

  const submit = () => {
    if (!canCreate) return
    onCreate({ key: trimmed, displayName: displayName.trim() || trimmed })
    setKey('')
    setDisplayName('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-role-dialog">
        <DialogHeader>
          <DialogTitle>Add a role</DialogTitle>
          <DialogDescription>
            A role is a job in this agent, like principal or verifier. A strategy fills its slots from these, and you change
            model by rebinding a role rather than editing the graph.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="role-key">Key</Label>
            <Input
              id="role-key"
              value={key}
              placeholder="principal"
              autoFocus
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            {duplicate && (
              <p data-testid="role-key-duplicate" className="mt-1 text-xs text-red-600 dark:text-red-400">
                This agent already has a role called {trimmed}.
              </p>
            )}
            {malformed && (
              <p data-testid="role-key-malformed" className="mt-1 text-xs text-red-600 dark:text-red-400">
                Lowercase letters, digits and underscores, starting with a letter — strategies match slots by this name.
              </p>
            )}
          </div>

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

          <div>
            <Label htmlFor="role-name">Name (optional)</Label>
            <Input
              id="role-name"
              value={displayName}
              placeholder={trimmed || 'Principal'}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>

          {error && (
            <p data-testid="add-role-error" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="create-role" disabled={!canCreate} onClick={submit}>
            {saving ? 'Adding...' : 'Add role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
