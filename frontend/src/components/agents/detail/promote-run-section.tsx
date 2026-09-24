/**
 * "Promote to skill" -- turns a completed agent run into a reusable
 * PromotedSkill (the promote step of run -> verify -> promote -> replay).
 *
 * Was a dialog. It is an inline section of the run it promotes: the button
 * sits under the run's detail and opens the form in place, so the run's
 * steps and output stay in view while naming the skill.
 */
import { useId, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

import { promotedSkillsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'

interface PromoteRunSectionProps {
  runId: string
}

export function PromoteRunSection({ runId }: PromoteRunSectionProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // A named-but-unpromoted skill asks before a navigation throws it away;
  // Cancel and a successful promote both clear the fields, so neither asks.
  const guard = useLeaveGuard(open && (name !== '' || description !== ''))
  const uid = useId()
  const formId = `promote-run-${uid}`

  const close = () => {
    setOpen(false)
    setName('')
    setDescription('')
  }

  const mutation = useMutation({
    mutationFn: () =>
      promotedSkillsApi.promote({
        runId,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      success('Skill promoted', 'The run is now a reusable skill.')
      queryClient.invalidateQueries({ queryKey: ['promoted-skills'] })
      close()
    },
    onError: (e: unknown) => {
      errorNotif('Promotion failed', getApiErrorMessage(e, 'Could not promote run'))
    },
  })

  if (!open) {
    return (
      <div className="flex justify-end pt-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          Promote to skill
        </Button>
      </div>
    )
  }

  return (
    <>
      <form
        id={formId}
        aria-label="Promote run to skill"
        className="space-y-3 rounded-md border bg-background p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          mutation.mutate()
        }}
      >
        <div className="space-y-1">
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            Promote run to skill
          </h4>
          <p className="text-xs text-muted-foreground">
            Distill this successful run into a reusable skill other agents can follow. Leave fields
            blank to derive them from the agent.
          </p>
        </div>
        <Field id={`${formId}-name`} label="Name">
          <Input
            value={name}
            maxLength={120}
            placeholder="e.g. Quarterly revenue report"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field id={`${formId}-description`} label="Description">
          <Textarea
            value={description}
            maxLength={500}
            placeholder="When should an agent reach for this skill?"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <InlineFormActions
          onCancel={close}
          submitLabel="Promote"
          submitting={mutation.isPending}
        />
      </form>
      {guard.element}
    </>
  )
}
