import { useState } from 'react'

import { VisibilityField, type Visibility, type VisibilityValue } from '@/components/ui/visibility-field'
import { useOrganizationStore } from '@/store/organization'

/**
 * Who can use something, in the one wording sharing has everywhere: the
 * picker's choices, the one line, the Credentials table.
 */
export const WHO_CAN_USE_LABELS: Record<Visibility, string> = {
  org: 'Everyone',
  team: 'One team',
  private: 'Only you',
}

export interface WhoCanUseProps {
  value: VisibilityValue
  onChange: (next: VisibilityValue) => void
  disabled?: boolean
  /** What the thing is called in the picker's copy ("this provider and its models"). */
  noun?: string
  /** The choices on offer; all three unless narrowed. One choice means nothing to change. */
  options?: Visibility[]
  /** False inside a details row whose label already asks the question. */
  showLabel?: boolean
}

/**
 * "Who can use it", as one line until someone wants to change it. The
 * choice itself is the shared visibility picker (Only you, One team, Everyone).
 * Connecting a provider and connecting a service both ask it this way.
 */
export function WhoCanUse({ value, onChange, disabled, noun = 'it', options, showLabel = true }: WhoCanUseProps) {
  const { currentOrganization } = useOrganizationStore()
  const [open, setOpen] = useState(false)
  const changeable = !options || options.length > 1
  if (!open) {
    return <WhoCanUseLine summary={WHO_CAN_USE_LABELS[value.visibility]} onChange={changeable ? () => setOpen(true) : undefined} disabled={disabled} showLabel={showLabel} />
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
 * `showLabel={false}` drops the "Who can use it:" prefix for a details row
 * that already says it in its label column.
 */
export function WhoCanUseLine({ summary, onChange, disabled, testId = 'who-can-use', showLabel = true }: { summary: string; onChange?: () => void; disabled?: boolean; testId?: string; showLabel?: boolean }) {
  return (
    <p className="text-sm" data-testid={testId}>
      {showLabel && <span className="text-muted-foreground">Who can use it: </span>}
      {summary}
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