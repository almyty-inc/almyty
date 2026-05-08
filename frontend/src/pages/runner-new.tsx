import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { ArrowLeft, ArrowRight, CheckCircle2, Copy, Loader2, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { runnersApi } from '@/lib/api'
import { RUNNER_HEARTBEAT_POLL_MS } from './runners-shared'

interface Runner { id: string; name: string; state: string; lastHeartbeatAt: string | null }

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

const schema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .regex(NAME_RE, 'Use letters, numbers, _, -; max 64 chars'),
})

type FormShape = z.infer<typeof schema>

interface LabelEntry { key: string; value: string }

export function RunnerNewPage() {
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()
  const { success } = useNotifications()
  const [labels, setLabels] = useState<LabelEntry[]>([])
  const [waitingFor, setWaitingFor] = useState<string | null>(null)

  const existingRunnersQuery = useQuery<Runner[]>({
    queryKey: ['runners', currentOrganization?.id],
    queryFn: () => runnersApi.getAll(),
    enabled: !!currentOrganization,
    refetchInterval: waitingFor ? 3_000 : RUNNER_HEARTBEAT_POLL_MS,
  })
  const existingNames = useMemo(
    () => new Set((existingRunnersQuery.data ?? []).map(r => r.name)),
    [existingRunnersQuery.data],
  )

  const form = useForm<FormShape>({
    resolver: zodResolver(schema),
    defaultValues: { name: '' },
  })

  const watchedName = form.watch('name')
  const nameTaken = watchedName.length > 0 && existingNames.has(watchedName) && watchedName !== waitingFor

  const command = useMemo(() => {
    const parts = ['npx', '@almyty/runner', 'start', '--name', shellQuote(watchedName || '<name>')]
    for (const { key, value } of labels) {
      if (key && value) parts.push('--label', shellQuote(`${key}=${value}`))
    }
    return parts.join(' ')
  }, [watchedName, labels])

  // Heartbeat detection: when the user has clicked "I started it",
  // poll the runners list and wait for a runner with our chosen name
  // whose state is online or busy. The transition is the success
  // signal that drives the page from "waiting" to "connected."
  useEffect(() => {
    if (!waitingFor) return
    const match = (existingRunnersQuery.data ?? []).find(r => r.name === waitingFor)
    if (match && (match.state === 'online' || match.state === 'busy') && match.lastHeartbeatAt) {
      success('Runner connected', `${match.name} is online`)
      navigate(`/runners/${match.id}`)
    }
  }, [waitingFor, existingRunnersQuery.data, navigate, success])

  const onSubmit = (values: FormShape) => {
    if (existingNames.has(values.name)) {
      form.setError('name', { message: `A runner named '${values.name}' is already registered` })
      return
    }
    setWaitingFor(values.name)
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/runners" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Runners
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold">Start a runner</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The almyty backend dispatches jobs to long-running daemons you start on machines you own.
          Three terminal commands and you're done.
        </p>
      </div>

      <ol className="space-y-6">
        <Step number={1} title="Name and label your runner" done={!!waitingFor}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
          >
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                disabled={!!waitingFor}
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
                  A runner named '{watchedName}' is already registered. Pick another name or
                  deregister the existing one first.
                </p>
              )}
            </div>

            <div>
              <Label>Labels (optional)</Label>
              <p className="text-xs text-muted-foreground mt-1">
                Routing tags. e.g. <code>env=dev</code>, <code>tier=staging</code>.
              </p>
              <div className="space-y-2 mt-2">
                {labels.map((label, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      value={label.key}
                      disabled={!!waitingFor}
                      onChange={e => setLabels(ls => ls.map((l, idx) => idx === i ? { ...l, key: e.target.value } : l))}
                      placeholder="key"
                      className="flex-1"
                    />
                    <Input
                      value={label.value}
                      disabled={!!waitingFor}
                      onChange={e => setLabels(ls => ls.map((l, idx) => idx === i ? { ...l, value: e.target.value } : l))}
                      placeholder="value"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={!!waitingFor}
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
                  disabled={!!waitingFor}
                  onClick={() => setLabels(ls => [...ls, { key: '', value: '' }])}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Add label
                </Button>
              </div>
            </div>

            {!waitingFor && (
              <Button type="submit" disabled={nameTaken}>
                Generate command
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
          </form>
        </Step>

        {waitingFor && (
          <Step number={2} title="Run these on the target machine" done={false}>
            <div className="space-y-4">
              <CommandBlock label="Install the runner once" command="npm i -g @almyty/runner" />
              <CommandBlock label="Make sure you're authenticated" command="npx @almyty/auth login" hint="One-time browser login. The runner picks up credentials automatically; no token in the start command." />
              <CommandBlock label="Start it" command={command} />
            </div>
          </Step>
        )}

        {waitingFor && (
          <Step number={3} title="Waiting for first heartbeat..." done={false}>
            <WaitingIndicator name={waitingFor} />
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
          <span className={`h-7 w-7 rounded-full flex items-center justify-center text-sm font-medium ${done ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground'}`}>
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
      <div className="mt-2 flex items-center gap-2 rounded border bg-muted/40 px-3 py-2 font-mono text-xs overflow-x-auto">
        <code className="flex-1 whitespace-nowrap">{command}</code>
        <Button type="button" variant="ghost" size="icon" onClick={onCopy} className="shrink-0">
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

function WaitingIndicator({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      <span className="text-muted-foreground">
        Waiting for <code>{name}</code> to register and send its first heartbeat. This page will
        redirect to the runner once it's online.
      </span>
    </div>
  )
}

/**
 * Quote a value for safe shell paste. Conservative: any character
 * outside the allowlist triggers single-quoting. Names already match
 * /^[a-zA-Z0-9_-]+$/ so this almost never triggers for the name; for
 * label values it makes paste-and-run robust against shell metas.
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./=:-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}
