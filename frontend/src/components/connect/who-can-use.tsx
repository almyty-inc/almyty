import { useState } from 'react'

import { VisibilityField, type Visibility, type VisibilityValue } from '@/components/ui/visibility-field'
import { useOrganizationStore } from '@/store/organization'

const SUMMARY: Record<Visibility, string> = {
  org: 'everyone in your organization',
  team: 'one team',
  private: 'only you',
}

export interface WhoCanUseProps {
  value: VisibilityValue
  onChange: (next: VisibilityValue) => void
  disabled?: boolean
  /** What the thing is called in the picker's copy ("this provider and its models"). */
  noun?: string
  /** The choices on offer; all three unless narrowed. One choice means nothing to change. */
  options?: Visibility[]
}

/**
 * "Who can use it", as one line until someone wants to change it. The
 * choice itself is the shared visibility picker (Private, Team, Org-wide).
 * Connecting a provider and connecting a service both ask it this way.
 */
export function WhoCanUse({ value, onChange, disabled, noun = 'it', options }: WhoCanUseProps) {
  const { currentOrganization } = useOrganizationStore()
  const [open, setOpen] = useState(false)
  const changeable = !options || options.length > 1
  if (!open) {
    return (
      <p className="text-sm" data-testid="who-can-use">
        <span className="text-muted-foreground">Who can use it:</span> {SUMMARY[value.visibility]}
        {changeable && (
          <>
            {' · '}
            <button type="button" className="text-primary hover:underline disabled:opacity-50" onClick={() => setOpen(true)} disabled={disabled}>
              Change
            </button>
          </>
        )}
      </p>
    )
  }
  return (
    <div data-testid="who-can-use-picker">
      <VisibilityField organizationId={currentOrganization?.id ?? ''} value={value} onChange={onChange} disabled={disabled} noun={noun} options={options} />
    </div>
  )
}
