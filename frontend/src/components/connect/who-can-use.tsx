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
    return <WhoCanUseLine summary={SUMMARY[value.visibility]} onChange={changeable ? () => setOpen(true) : undefined} disabled={disabled} />
  }
  return (
    <div data-testid="who-can-use-picker">
      <VisibilityField organizationId={currentOrganization?.id ?? ''} value={value} onChange={onChange} disabled={disabled} noun={noun} options={options} />
    </div>
  )
}

/**
 * The one line itself: "Who can use it: <summary> · Change". Shared by
 * everything that answers that question, whatever the choices behind it
 * are (a provider's visibility, who may open an app). No onChange, no link.
 */
export function WhoCanUseLine({ summary, onChange, disabled, testId = 'who-can-use' }: { summary: string; onChange?: () => void; disabled?: boolean; testId?: string }) {
  return (
    <p className="text-sm" data-testid={testId}>
      <span className="text-muted-foreground">Who can use it:</span> {summary}
      {onChange && (
        <>
          {' · '}
          <button type="button" className="text-primary hover:underline disabled:opacity-50" onClick={onChange} disabled={disabled}>
            Change
          </button>
        </>
      )}
    </p>
  )
}
