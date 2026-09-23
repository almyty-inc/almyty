import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
import { agentAppsApi, appSlugError, slugify } from '@/lib/agent-apps'

/**
 * Creating an app: a name, the address it lives at, and what it is for.
 *
 * Everything else -- agents, branding, spending and visitor defaults --
 * is set on the app itself afterwards, so this stays three fields.
 */
export function CreateAppForm() {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const guard = useLeaveGuard(!!(name || slug || description))

  // The address follows the name until someone edits it themselves,
  // after which it stays put: silently rewriting a slug someone chose
  // is the kind of thing that changes a URL out from under them.
  const effectiveSlug = slugTouched ? slug : slugify(name)
  const nameError = submitted && !name.trim() ? 'Give the app a name.' : undefined
  const slugError =
    effectiveSlug || submitted ? appSlugError(effectiveSlug) ?? undefined : undefined

  const create = useMutation({
    mutationFn: () =>
      agentAppsApi.create({
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || null,
        agentIds: [],
      }),
    onSuccess: (app) => {
      success('App created', 'Add agents and a distribution.')
      queryClient.invalidateQueries({ queryKey: ['agent-apps'] })
      guard.leave(`/apps/${app.slug}`)
    },
    onError: (err: unknown) =>
      errorNotif('Could not create the app', getApiErrorMessage(err, 'Please try again.')),
  })

  return (
    <FormPage
      title="Create app"
      description="An app is your agents under your own name. Safe spending, message-rate, and visitor-privacy defaults are applied automatically; change them in Settings."
      back={{ to: '/apps', label: 'Apps' }}
      guard={guard}
      width="narrow"
      submitLabel="Create app"
      submitting={create.isPending}
      onSubmit={() => {
        setSubmitted(true)
        if (!name.trim() || appSlugError(effectiveSlug)) return
        create.mutate()
      }}
    >
      <div className="space-y-4">
        <Field id="app-name" label="Name" required error={nameError}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Support"
            autoFocus
          />
        </Field>

        <Field
          id="app-slug"
          label="Address"
          required
          hint={slugError ? undefined : 'Used in the URL and as the name of anything you build from it.'}
          error={slugError}
        >
          <Input
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(e.target.value.toLowerCase())
            }}
            placeholder="acme-support"
          />
        </Field>

        <Field id="app-description" label="Description" hint="Shown to your team, not to the people using the app.">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this app is for"
            rows={3}
          />
        </Field>
      </div>
    </FormPage>
  )
}
