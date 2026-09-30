/**
 * The model a work mode slot uses: the one place the autonomous builder
 * chooses a model for a role. Every slot (main, drafter, checker,
 * panelist, judge, explorer, summariser, model teammate) renders the
 * shared ModelPicker through here, with its price, status and inline
 * "Add a connection".
 */
import { ModelPicker, type ModelSelection } from '@/components/model-picker'

export interface SlotModelChooserProps {
  /** Prefix for element ids, so two slots on one screen stay distinct. */
  idPrefix: string
  value: ModelSelection
  onChange: (next: ModelSelection) => void
}

export function SlotModelChooser({ idPrefix, value, onChange }: SlotModelChooserProps) {
  return <ModelPicker idPrefix={idPrefix} compact allowRouting value={value} onChange={(next) => onChange(next)} />
}
