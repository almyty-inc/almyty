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
export function WhoCanUse({ value, onChange, disabled }: { value: VisibilityValue; onChange: (next: VisibilityValue) => void; disabled?: boolean }) {
  const { currentOrganization } = useOrganizationStore()
  const [open, setOpen] = useState(false)
  if (!open) {
    return <WhoCanUseLine summary={SUMMARY[value.visibility]} onChange={() => setOpen(true)} disabled={disabled} />
  }
  return (
    <div data-testid="who-can-use-picker">
      <VisibilityField organizationId={currentOrganization?.id ?? ''} value={value} onChange={onChange} disabled={disabled} noun="this provider and its models" />
    </div>
  )
}

/**
 * The one line itself: "Who can use it: <summary> · Change". Shared by
 * everything that answers that question, whatever the choices behind it
 * are (a provider's visibility, who may open an app).
 */
export function WhoCanUseLine({ summary, onChange, disabled, testId = 'who-can-use' }: { summary: string; onChange: () => void; disabled?: boolean; testId?: string }) {
  return (
    <p className="text-sm" data-testid={testId}>
      <span className="text-muted-foreground">Who can use it:</span> {summary}
      {' · '}
      <button type="button" className="text-primary hover:underline disabled:opacity-50" onClick={onChange} disabled={disabled}>
        Change
      </button>
    </p>
  )
}
