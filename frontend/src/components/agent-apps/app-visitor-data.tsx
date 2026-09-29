import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Download, Search, ShieldCheck, Trash2, UserX } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { getApiErrorMessage } from '@/lib/api-error'
import { downloadBlob } from '@/lib/hosted-chat'
import { formatDate, pluralized } from '@/lib/utils'
import {
  DISTRIBUTION_LABELS,
  PERSON_IDENTIFIER_HINTS,
  isPeoplePlace,
  visitorDataApi,
  type AgentApp,
  type DistributionTarget,
  type VisitorDataRequest,
  type VisitorDataSummary,
  type VisitorErasure,
} from '@/lib/agent-apps'

export interface AppVisitorDataProps {
  app: Pick<AgentApp, 'slug' | 'name' | 'distributions'>
}

/** "3 conversations, 12 messages, 1 memory" from whichever counts are not zero. */
export function heldLine(counts: Partial<Record<keyof VisitorErasure, number>>): string {
  const parts: string[] = []
  const add = (n: number | undefined, word: string, plural?: string) => {
    if (n) parts.push(pluralized(n, word, plural))
  }
  add(counts.conversations, 'conversation')
  add(counts.messages, 'message')
  add(counts.memories, 'memory', 'memories')
  add(counts.files, 'file')
  add(counts.storedReplies, 'stored reply', 'stored replies')
  add(counts.runs, 'run')
  return parts.length ? parts.join(', ') : 'nothing'
}

/**
 * Answering one person's data request, on the app page.
 *
 * People on the web chat and the website widget download and delete their
 * own data. Someone who messaged the app on Slack or by SMS, or an agent
 * calling it over A2A, has no page to do that on, so they ask the owner.
 * The owner picks the place, types what that place knows the person by,
 * sees what is held in counts and dates, and sends them their copy or
 * deletes it. The confirm before deleting is the one dialog the product
 * allows. Every download and deletion lands in the audit log.
 */
export function AppVisitorData({ app }: AppVisitorDataProps) {
  const places = (app.distributions ?? []).filter((d) => isPeoplePlace(d.target) && !!d.gatewayId)
  const [place, setPlace] = useState<DistributionTarget | ''>(places[0]?.target ?? '')
  const [identifier, setIdentifier] = useState('')
  // The request the summary on screen answers: download and delete act on
  // exactly the person who was looked up, not on what the field says now.
  const [shown, setShown] = useState<{ request: VisitorDataRequest; summary: VisitorDataSummary } | null>(null)
  const [erased, setErased] = useState<{ request: VisitorDataRequest; removed: VisitorErasure } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { confirm, dialog } = useConfirm()

  const lookup = useMutation({
    mutationFn: (request: VisitorDataRequest) => visitorDataApi.lookup(app.slug, request).then((summary) => ({ request, summary })),
    onMutate: () => {
      setError(null)
      setErased(null)
      setShown(null)
    },
    onSuccess: (result) => setShown(result),
    onError: (err) => setError(getApiErrorMessage(err, 'Could not look them up.')),
  })

  const download = useMutation({
    mutationFn: (request: VisitorDataRequest) => visitorDataApi.export(app.slug, request),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      downloadBlob(blob, `${app.slug}-${place || 'data'}-request.json`)
    },
    onError: (err) => setError(getApiErrorMessage(err, 'Could not download their data.')),
  })

  const erase = useMutation({
    mutationFn: (request: VisitorDataRequest) => visitorDataApi.erase(app.slug, request).then((removed) => ({ request, removed })),
    onMutate: () => setError(null),
    onSuccess: (result) => {
      setErased(result)
      setShown(null)
    },
    onError: (err) => setError(getApiErrorMessage(err, 'Could not delete their data.')),
  })

  if (places.length === 0) {
    return (
      <EmptyState
        variant="panel"
        icon={ShieldCheck}
        title="Nobody can reach this app yet"
        description="Once it is on the web, your website, a messaging app or A2A, you can look people up here to send them their data or delete it."
      />
    )
  }

  const hint = place ? PERSON_IDENTIFIER_HINTS[place] : null
  const placeLabel = (target: DistributionTarget) => DISTRIBUTION_LABELS[target]
  const trimmed = identifier.trim()

  const onLookup = (event: FormEvent) => {
    event.preventDefault()
    if (!place || !trimmed) return
    lookup.mutate({ place, id: trimmed })
  }

  const onErase = async () => {
    if (!shown) return
    const ok = await confirm({
      title: "Delete this person's data?",
      description: `Everything this app holds for ${shown.request.id} on ${placeLabel(shown.request.place)} is deleted: ${heldLine(shown.summary)}. This cannot be undone.`,
      confirmLabel: 'Delete data',
      destructive: true,
    })
    if (ok) erase.mutate(shown.request)
  }

  return (
    <div className="space-y-6" data-testid="app-visitor-data">
      {dialog}
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Answer a data request</h2>
        <p className="text-sm text-muted-foreground">
          People on the web chat and your website widget can download and delete their own data. Anyone else,
          such as someone who messaged the app on Slack or an agent that called it over A2A, asks you. Look them
          up by what the place knows them by, then send them their data or delete it.
        </p>
      </div>

      <form onSubmit={onLookup} className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor="visitor-data-place">Where they used it</Label>
          <Select
            value={place}
            onValueChange={(value) => {
              setPlace(value as DistributionTarget)
              setShown(null)
              setErased(null)
            }}
          >
            <SelectTrigger id="visitor-data-place">
              <SelectValue placeholder="Pick a place" />
            </SelectTrigger>
            <SelectContent>
              {places.map((d) => (
                <SelectItem key={d.target} value={d.target}>
                  {placeLabel(d.target)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="visitor-data-id">{hint?.label ?? 'Who'}</Label>
          <Input
            id="visitor-data-id"
            value={identifier}
            placeholder={hint?.placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setIdentifier(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={!place || !trimmed || lookup.isPending}>
          <Search className="mr-2 h-4 w-4" />
          {lookup.isPending ? 'Looking up…' : 'Look up'}
        </Button>
        {hint?.help ? <p className="text-xs text-muted-foreground sm:col-span-3">{hint.help}</p> : null}
      </form>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {erased ? (
        <Card className="p-4" role="status" data-testid="visitor-data-erased">
          <p className="text-sm font-medium">Deleted</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Removed {heldLine(erased.removed)} for {erased.request.id} on {placeLabel(erased.request.place)}. The
            deletion is in the audit log.
          </p>
        </Card>
      ) : null}

      {shown && !shown.summary.found ? (
        <Card className="p-4" role="status" data-testid="visitor-data-none">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UserX className="h-4 w-4 text-muted-foreground" />
            Nothing held for {shown.request.id} on {placeLabel(shown.request.place)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Check how the place writes it: a Slack member id is not a display name, and a phone number needs its
            country code.
          </p>
        </Card>
      ) : null}

      {shown?.summary.found ? (
        <Card className="space-y-4 p-4" data-testid="visitor-data-summary">
          <div>
            <p className="text-sm font-medium">
              What this app holds for {shown.request.id} on {placeLabel(shown.request.place)}
            </p>
            {shown.summary.firstAt && shown.summary.lastAt ? (
              <p className="mt-1 text-xs text-muted-foreground">
                First message {formatDate(shown.summary.firstAt)}, last {formatDate(shown.summary.lastAt)}
              </p>
            ) : null}
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <Held label="Conversations" value={shown.summary.conversations} />
            <Held label="Messages" value={shown.summary.messages} />
            <Held label="Memories written for them" value={shown.summary.memories} />
            <Held label="Stored replies" value={shown.summary.storedReplies} />
            <Held label="Files" value={shown.summary.files} />
            <Held label="Runs" value={shown.summary.runs} />
          </dl>
          {shown.summary.recent.length > 0 ? (
            <ul className="divide-y rounded-md border text-sm" aria-label="Their conversations">
              {shown.summary.recent.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="truncate">{c.title || 'Untitled conversation'}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {pluralized(c.messages, 'message')}
                    {c.lastAt ? ` · ${formatDate(c.lastAt)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => download.mutate(shown.request)} disabled={download.isPending}>
              <Download className="mr-2 h-4 w-4" />
              {download.isPending ? 'Preparing…' : 'Download their data'}
            </Button>
            <Button variant="destructive" onClick={onErase} disabled={erase.isPending}>
              <Trash2 className="mr-2 h-4 w-4" />
              {erase.isPending ? 'Deleting…' : 'Delete their data'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The download is a JSON file to send them. Each download and deletion is recorded in the audit log,
            without their details.
          </p>
        </Card>
      ) : null}
    </div>
  )
}

function Held({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}
