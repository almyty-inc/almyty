import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { ArrowLeft, ArrowRight, CheckCircle2, Copy, Loader2, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { useAuthStore } from '@/store/auth'
import { runnersApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  RUNNER_HEARTBEAT_POLL_MS,
  RUNNER_INSTALL_COMMAND,
  RUNNER_LOGIN_COMMAND,
  isPendingRunner,
  runnerStartCommand,
} from './runners-shared'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { VisibilityBadge, useTeamLookup } from '@/components/ui/team-filter'

interface Runner {
  id: string
  name: string
  state: string
  ownerUserId?: string
  labels?: Record<string, string>
  visibility?: 'private' | 'team' | 'org'
  teamId?: string | null
  runtimeInfo?: unknown
  lastHeartbeatAt: string | null
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

const schema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .regex(NAME_RE, 'Use letters, numbers, _, -; max 64 chars'),
})

type FormShape = z.infer<typeof schema>

interface LabelEntry { key: string; value: string }

type Stage = 'form' | 'command'

/**
 * Setup flow for a runner, on its own page.
 *
 * "Generate command" creates the runner record server-side (pending:
 * never connected) holding the name, labels and visibility, so the start
 * command only carries the name. From step 2 the user can go back and
 * change anything (the pending record is updated in place), or cancel,
 * which deletes the pending record so an abandoned setup leaves nothing
 * behind. A pending runner that is left anyway shows on the Runners list
 * as "never connected" and can be deleted there.
 */
export function RunnerNewPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const { user } = useAuthStore()
  const { success, error: notifyError } = useNotifications()
  const [labels, setLabels] = useState<LabelEntry[]>([])
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'private', teamId: null })
  const [stage, setStage] = useState<Stage>('form')
  const [pending, setPending] = useState<Runner | null>(null)
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)

  useEffect(() => {
    document.title = 'Start a runner | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const existingRunnersQuery = useQuery<Runner[]>({
    queryKey: ['runners', currentOrganization?.id],
    queryFn: () => runnersApi.getAll(),
    enabled: !!currentOrganization,
    refetchInterval: RUNNER_HEARTBEAT_POLL_MS,
  })
  const others = useMemo(
    () => (existingRunnersQuery.data ?? []).filter(r => r.id !== pending?.id),
    [existingRunnersQuery.data, pending?.id],
  )
  const existingNames = useMemo(() => new Set(others.map(r => r.name)), [others])
  // v1 runs one runner per account. Say so up front rather than after
  // the user has filled in the form.
  const ownRunner = others.find(r => !!user?.id && r.ownerUserId === user.id)

  // Poll the record we created until its daemon's first heartbeat.
  const pendingQuery = useQuery<Runner>({
    queryKey: ['runner', pending?.id],
    queryFn: () => runnersApi.getById(pending!.id),
    enabled: !!pending && stage === 'command',
    refetchInterval: 3_000,
  })

  const form = useForm<FormShape>({
    resolver: zodResolver(schema),
    defaultValues: { name: '' },
  })

  const watchedName = form.watch('name')
  const nameTaken = watchedName.length > 0 && existingNames.has(watchedName)

  useEffect(() => {
    const live = pendingQuery.data
    if (live && (live.state === 'online' || live.state === 'busy') && live.lastHeartbeatAt) {
      success('Runner connected', `${live.name} is online`)
      queryClient.invalidateQueries({ queryKey: ['runners'] })
      navigate(`/runners/${live.id}`)
    }
  }, [pendingQuery.data, navigate, success, queryClient])

  const saveMutation = useMutation({
    mutationFn: (values: FormShape) => {
      const body = {
        name: values.name,
        labels: Object.fromEntries(labels.filter(l => l.key && l.value).map(l => [l.key, l.value])),
        visibility: visibility.visibility,
        teamId: visibility.visibility === 'team' ? visibility.teamId : null,
      }
      return pending ? runnersApi.update(pending.id, body) : runnersApi.create(body)
    },
    onSuccess: (runner: Runner) => {
      setPending(runner)
      setStage('command')
      queryClient.invalidateQueries({ queryKey: ['runners'] })
    },
    onError: (err) => {
      form.setError('name', { message: getApiErrorMessage(err, 'Could not create the runner') })
    },
  })

  // Cancelling removes the record we created, but only while it has
  // never connected: a runner whose daemon is already talking to us is
  // a real runner, and deleting it is the Runners page's job.
  const cancelMutation = useMutation({
    mutationFn: async () => {
      const current = pendingQuery.data ?? pending
      if (current && isPendingRunner(current)) await runnersApi.unregister(current.id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['runners'] })
      navigate('/runners')
    },
    onError: (err) => notifyError('Could not cancel the setup', getApiErrorMessage(err)),
  })

  const onSubmit = (values: FormShape) => {
    if (existingNames.has(values.name)) {
      form.setError('name', { message: `A runner named '${values.name}' already exists in this organization` })
      return
    }
    saveMutation.mutate(values)
  }

  const startCommand = runnerStartCommand(pending?.name ?? watchedName, currentOrganization?.id)
  const shown = pendingQuery.data ?? pending

  return (
    <div className="space-y-6">
      <div>
        <Link to="/runners" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Runners
        </Link>
      </div>

      <div>
        <h1 className={DETAIL_TITLE_CLASSES}>Start a runner</h1>
        <p className="text-sm text-muted-foreground mt-1">
          A runner is a small daemon on a machine you own. Agents send it work; it runs that work there, as you.
        </p>
      </div>

      {ownRunner && stage === 'form' && (
        <Card>
          <CardContent className="pt-6 text-sm">
            You already have a runner, <Link className="font-medium underline underline-offset-4" to={`/runners/${ownRunner.id}`}>{ownRunner.name}</Link>.
            {' '}Each account runs one runner for now; delete that one before setting up another.
          </CardContent>
        </Card>
      )}

      <ol className="space-y-6">
        <Step number={1} title="Name and label your runner" done={stage === 'command'}>
          {stage === 'form' ? (
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  {...form.register('name')}
                  placeholder="my-laptop"
                  autoComplete="off"
                  className="mt-1"
                />
                {form.formState.errors.name && (
                  <p className="text-sm text-destructive mt-1">{form.formState.errors.name.message}</p>
                )}
                {!form.formState.errors.name && nameTaken && (
                  <p className="text-sm text-destructive mt-1">
                    A runner named '{watchedName}' already exists in this organization. Pick another name.
                  </p>
                )}
              </div>

              <div>
                <Label>Labels (optional)</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Descriptive tags, e.g. <code>env=dev</code>, <code>tier=staging</code>.
                  {' '}Labels do not affect where work is dispatched yet.
                </p>
                <div className="space-y-2 mt-2">
                  {labels.map((label, i) => (
                    <div key={i} className="flex gap-2">
                      <Input
                        value={label.key}
                        aria-label={`Label ${i + 1} key`}
                        onChange={e => setLabels(ls => ls.map((l, idx) => idx === i ? { ...l, key: e.target.value } : l))}
                        placeholder="key"
                        className="flex-1 min-w-0"
                      />
                      <Input
                        value={label.value}
                        aria-label={`Label ${i + 1} value`}
                        onChange={e => setLabels(ls => ls.map((l, idx) => idx === i ? { ...l, value: e.target.value } : l))}
                        placeholder="value"
                        className="flex-1 min-w-0"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove label ${i + 1}`}
                        onClick={() => setLabels(ls => ls.filter((_, idx) => idx !== i))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setLabels(ls => [...ls, { key: '', value: '' }])}
                  >
                    <Plus className="mr-1 h-4 w-4" />
                    Add label
                  </Button>
                </div>
              </div>
              <div className="border-t pt-4">
                <VisibilityField
                  organizationId={currentOrganization?.id ?? ''}
                  value={visibility}
                  onChange={setVisibility}
                  noun="this runner"
                />
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                <Button type="submit" disabled={nameTaken || saveMutation.isPending}>
                  {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {pending ? 'Update command' : 'Generate command'}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => (pending ? cancelMutation.mutate() : navigate('/runners'))}
                  disabled={cancelMutation.isPending}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <code className="font-medium">{shown?.name}</code>
                <VisibilityBadge visibility={shown?.visibility} teamId={shown?.teamId} teamLookup={teamLookup} />
                {Object.entries(shown?.labels ?? {}).map(([k, v]) => (
                  <code key={k} className="text-xs text-muted-foreground">{k}={v}</code>
                ))}
              </div>
              {shown && isPendingRunner(shown) && (
                <Button type="button" variant="outline" size="sm" onClick={() => setStage('form')}>
                  <Pencil className="mr-1 h-4 w-4" />
                  Back to edit
                </Button>
              )}
            </div>
          )}
        </Step>

        {stage === 'command' && pending && (
          <Step number={2} title="Run these on the target machine" done={false}>
            <div className="space-y-4">
              <CommandBlock label="Install once" command={RUNNER_INSTALL_COMMAND} />
              <CommandBlock
                label="Log in as yourself"
                command={RUNNER_LOGIN_COMMAND}
                hint="One-time browser login. The runner reads this login; no token goes in the start command."
              />
              <CommandBlock
                label="Start it"
                command={startCommand}
                hint="Commands your agents dispatch run as the user who starts this, on that machine. Package installs are refused by default, and allowedCwdRoots / denyPatterns in ~/.almyty/config.json narrow it further. The daemon prints its posture at boot."
              />
              <p className="flex gap-2 rounded-md border p-3 text-sm">
                <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-primary" aria-hidden="true" />
                <span data-testid="runner-identity">
                  The runner is identified and authorised by your almyty login on that machine, not by its name: it connects as whoever ran <code>{RUNNER_LOGIN_COMMAND}</code>, so nobody else can attach to it even if they know the name.
                </span>
              </p>
              <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center">
                <Button type="button" variant="outline" onClick={() => setStage('form')} disabled={!!shown && !isPendingRunner(shown)}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => cancelMutation.mutate()}
                  disabled={cancelMutation.isPending}
                >
                  {cancelMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                  Cancel and delete this runner
                </Button>
              </div>
            </div>
          </Step>
        )}

        {stage === 'command' && pending && (
          <Step number={3} title="Waiting for first heartbeat..." done={false}>
            <WaitingIndicator name={pending.name} />
          </Step>
        )}
      </ol>
    </div>
  )
}

function Step({ number, title, done, children }: { number: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <li>
      <Card>
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <span className={`h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-sm font-medium ${done ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground'}`}>
            {done ? <CheckCircle2 className="h-4 w-4" /> : number}
          </span>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </li>
  )
}

function CommandBlock({ label, command, hint }: { label: string; command: string; hint?: string }) {
  const { success } = useNotifications()
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      success('Copied', 'Command copied to clipboard')
    } catch {
      // Clipboard API unavailable in some contexts; user can still
      // select the text manually. Failing silently is fine here.
    }
  }
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      <div className="mt-2 flex items-center gap-2 rounded border bg-muted/40 px-3 py-2 font-mono text-xs">
        <code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap">{command}</code>
        <Button type="button" variant="ghost" size="icon" onClick={onCopy} className="shrink-0" aria-label={`Copy ${label.toLowerCase()} command`} title="Copy command">
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

function WaitingIndicator({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      <span className="text-muted-foreground">
        Waiting for <code>{name}</code> to send its first heartbeat. This page will
        open the runner once it's online.
      </span>
    </div>
  )
}