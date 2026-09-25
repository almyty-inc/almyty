import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { AgentSelect, type AgentOption } from '@/components/agents/agent-select'
import { Field, FormPage } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { getApiErrorMessage } from '@/lib/api-error'
import { agentAppsApi, appSlugError, slugify } from '@/lib/agent-apps'
import { agentsQuery } from '@/lib/list-queries'

/**
 * Creating an app: the agent it puts in front of people, a name, and the
 * address it lives at. The agent comes first and is required, so an app is
 * never born with nothing to talk to; the name follows the agent until
 * someone types their own.
 *
 * Everything else -- more agents, branding, spending and visitor
 * defaults -- is set on the app itself afterwards.
 */
export function CreateAppForm() {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const { currentOrganization } = useOrganizationStore()

  const [agent, setAgent] = useState<AgentOption | null>(null)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const agentsQ = useQuery({ ...agentsQuery(currentOrganization?.id), enabled: !!currentOrganization })
  const agents = ((agentsQ.data ?? []) as AgentOption[]).filter((a) => a?.id)

  const guard = useLeaveGuard(!!(agent || name || slug || description))

  const effectiveName = nameTouched ? name : agent?.name ?? ''
  // The address follows the name until someone edits it themselves,
  // after which it stays put: silently rewriting a slug someone chose
  // is the kind of thing that changes a URL out from under them.
  const effectiveSlug = slugTouched ? slug : slugify(effectiveName)
  const agentError = submitted && !agent ? 'Pick the agent people will talk to.' : undefined
  const nameError = submitted && !effectiveName.trim() ? 'Give the app a name.' : undefined
  const slugError =
    effectiveSlug || submitted ? appSlugError(effectiveSlug) ?? undefined : undefined

  const create = useMutation({
    mutationFn: () =>
      agentAppsApi.create({
        name: effectiveName.trim(),
        slug: effectiveSlug,
        description: description.trim() || null,
        agentIds: agent ? [agent.id] : [],
      }),
    onSuccess: (app) => {
      success('App created', 'Now pick where people use it.')
      queryClient.invalidateQueries({ queryKey: ['agent-apps'] })
      guard.leave(`/apps/${app.slug}`)
    },
    onError: (err: unknown) =>
      errorNotif('Could not create the app', getApiErrorMessage(err, 'Please try again.')),
  })

  const noAgents = !agentsQ.isLoading && !agentsQ.isError && agents.length === 0

  return (
    <FormPage
      title="Create app"
      description="An app puts your agent in front of people: on the web, in Slack or another chat app, or as a terminal or desktop app."
      back={{ to: '/apps', label: 'Apps' }}
      guard={guard}
      width="narrow"
      submitLabel="Create app"
      submitting={create.isPending}
      onSubmit={() => {
        setSubmitted(true)
        if (!agent || !effectiveName.trim() || appSlugError(effectiveSlug)) return
        create.mutate()
      }}
    >
      <div className="space-y-4">
        {agentsQ.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : noAgents ? (
          <div className="space-y-1.5 rounded-lg border border-dashed p-4 text-sm" data-testid="app-no-agents" data-invalid={agentError ? 'true' : undefined}>
            <p className="font-medium">An app needs an agent</p>
            <p className="text-muted-foreground">
              You have no agents yet. <Link to="/agents/new" className="text-primary hover:underline">Create an agent</Link>, then come back here.
            </p>
          </div>
        ) : (
          <Field id="app-agent" label="Agent" required error={agentError} hint={agentError ? undefined : 'Who people talk to. You can add more agents later.'}>
            <AgentSelect agents={agents} value={agent?.id} onChange={setAgent} />
          </Field>
        )}

        <Field id="app-name" label="Name" required error={nameError}>
          <Input
            value={effectiveName}
            onChange={(e) => {
              setNameTouched(true)
              setName(e.target.value)
            }}
            placeholder="Acme Support"
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

        <p className="text-xs text-muted-foreground">
          Safe spending, message-rate and visitor-privacy defaults are applied automatically. Change them in the app's Settings.
        </p>
      </div>
    </FormPage>
  )
}
