import { useState } from 'react'

import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { useOrganizationStore } from '@/store/organization'

const SUMMARY: Record<VisibilityValue['visibility'], string> = {
  org: 'everyone in your organization',
  team: 'one team',
  private: 'only you',
}

/**
 * "Who can use it", as one line until someone wants to change it. The
 * choice itself is the shared visibility picker (Private, Team, Org-wide).
 */
export function WhoCanUse({
  value,
  onChange,
  disabled,
  noun = 'this provider and its models',
}: {
  value: VisibilityValue
  onChange: (next: VisibilityValue) => void
  disabled?: boolean
  /** What the thing is called in the picker's copy. */
  noun?: string
}) {
  const { currentOrganization } = useOrganizationStore()
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <p className="text-sm" data-testid="who-can-use">
        <span className="text-muted-foreground">Who can use it:</span> {SUMMARY[value.visibility]}
        {' · '}
        <button type="button" className="text-primary hover:underline disabled:opacity-50" onClick={() => setOpen(true)} disabled={disabled}>
          Change
        </button>
      </p>
    )
  }
  return (
    <div data-testid="who-can-use-picker">
      <VisibilityField organizationId={currentOrganization?.id ?? ''} value={value} onChange={onChange} disabled={disabled} noun={noun} />
    </div>
  )
}
