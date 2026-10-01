/**
 * Visitor data: answering one person's request for their data, for one
 * agent, across its channels.
 *
 * People on the web chat and the website chat bubble can download and
 * delete their own data there. Someone who wrote to the agent on Slack,
 * WhatsApp, by text message or email, or another agent that called it
 * over A2A, has nowhere to do that, so they ask the owner. The owner says
 * who they are (an email address, a phone number, a member id), on one
 * channel or all of them, sees what is kept about them in counts and
 * dates, and sends them a copy or deletes it. The one dialog is the
 * "Delete this person's data?" confirm. Every download and deletion is
 * in the audit log.
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Download, ShieldCheck, Trash2, UserX } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { channelsTabPath } from '@/components/channels/channel-page-loader'
import { ChannelIcon } from '@/components/channels/channel-meta'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  ANY_CHANNEL_HINT,
  PERSON_IDENTIFIER_HINTS,
  holdsVisitorData,
  visitorDataApi,
  type AgentChannel,
  type VisitorDataRequest,
  type VisitorDataSummary,
  type VisitorErasure,
} from '@/lib/agent-channels'
import { downloadBlob } from '@/lib/hosted-chat'
import { formatDate, pluralized } from '@/lib/utils'

const ALL = 'all'

/** "3 conversations, 12 messages, 1 memory" from whichever counts are not zero. */
export function heldLine(counts: Partial<Record<keyof VisitorErasure | keyof VisitorDataSummary, unknown>>): string {
  const parts: string[] = []
  const add = (n: unknown, word: string, plural?: string) => {
    if (typeof n === 'number' && n > 0) parts.push(pluralized(n, word, plural))
  }
  add(counts.conversations, 'conversation')
  add(counts.messages, 'message')
  add(counts.memories, 'memory', 'memories')
  add(counts.files, 'file')
  add(counts.storedReplies, 'saved reply', 'saved replies')
  add(counts.runs, 'run')
  return parts.length ? parts.join(', ') : 'nothing'
}

type Conversation = VisitorDataSummary['recent'][number]

const CONVERSATION_COLUMNS: ColumnDef<Conversation, any>[] = [
  {
    id: 'title',
    header: 'Conversation',
    cell: ({ row }) => <span className="font-medium">{row.original.title || 'Untitled conversation'}</span>,
  },
  {
    id: 'messages',
    header: 'Messages',
    cell: ({ row }) => <span className="tabular-nums">{row.original.messages}</span>,
  },
  {
    id: 'last',
    header: 'Last message',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.lastAt ? formatDate(row.original.lastAt) : '—'}</span>,
  },
]

export interface VisitorDataRequestPageProps {
  agent: { id: string; name: string }
  channels: AgentChannel[]
}

export function VisitorDataRequestPage({ agent, channels }: VisitorDataRequestPageProps) {
  const people = channels.filter((c) => holdsVisitorData(c.type) && !!c.gatewayId)
  const [channelId, setChannelId] = useState<string>(ALL)
  const [identifier, setIdentifier] = useState('')
  const [touched, setTouched] = useState(false)
  // The request the result on screen answers: download and delete act on
  // exactly the person who was looked up, not on what the field says now.
  const [shown, setShown] = useState<{ request: VisitorDataRequest; summary: VisitorDataSummary } | null>(null)
  const [erased, setErased] = useState<{ request: VisitorDataRequest; removed: VisitorErasure } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { confirm, dialog } = useConfirm()

  const selected = people.find((c) => c.id === channelId)
  const hint = selected ? (PERSON_IDENTIFIER_HINTS[selected.type] ?? ANY_CHANNEL_HINT) : ANY_CHANNEL_HINT
  const trimmed = identifier.trim()
  const where = (request: VisitorDataRequest) => {
    const channel = people.find((c) => c.id === request.channelId)
    return channel ? `on ${channel.name}` : `on any of ${agent.name}'s channels`
  }

  const lookup = useMutation({
    mutationFn: (request: VisitorDataRequest) => visitorDataApi.lookup(agent.id, request).then((summary) => ({ request, summary })),
    onMutate: () => {
      setError(null)
      setErased(null)
      setShown(null)
    },
    onSuccess: (result) => setShown(result),
    onError: (err) => setError(getApiErrorMessage(err, 'Could not look them up. Try again.')),
  })

  const download = useMutation({
    mutationFn: (request: VisitorDataRequest) => visitorDataApi.export(agent.id, request),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      downloadBlob(blob, 'data-request.json')
    },
    onError: (err) => setError(getApiErrorMessage(err, 'Could not download their data. Try again.')),
  })

  const erase = useMutation({
    mutationFn: (request: VisitorDataRequest) => visitorDataApi.erase(agent.id, request).then((removed) => ({ request, removed })),
    onMutate: () => setError(null),
    onSuccess: (result) => {
      setErased(result)
      setShown(null)
    },
    onError: (err) => setError(getApiErrorMessage(err, 'Could not delete their data. Try again.')),
  })

  const onLookup = () => {
    setTouched(true)
    if (!trimmed) return
    lookup.mutate({ id: trimmed, ...(channelId !== ALL ? { channelId } : {}) })
  }

  const onErase = async () => {
    if (!shown) return
    const ok = await confirm({ title: "Delete this person's data?", confirmLabel: 'Delete their data', destructive: true })
    if (ok) erase.mutate(shown.request)
  }

  const back = { to: channelsTabPath(agent.id), label: agent.name }
  const title = 'Visitor data'
  const description = `Find what ${agent.name} keeps about one person, send them a copy, or delete it.`

  if (people.length === 0) {
    return (
      <FormPage title={title} description={description} back={back}>
        <EmptyState
          variant="panel"
          icon={ShieldCheck}
          title="Nobody can talk to this agent yet"
          description="Once it has a web chat, a chat bubble on your website, a messaging channel or A2A, you can look people up here."
        />
      </FormPage>
    )
  }

  return (
    <FormPage
      title={title}
      description={description}
      back={back}
      onSubmit={onLookup}
      submitLabel="Look up"
      submitting={lookup.isPending}
    >
      {dialog}
      <FormSection
        title="Who is asking"
        description="People on your web chat and your website's chat bubble can download and delete their own data there. Anyone else asks you, and you answer here."
      >
        <Field id="visitor-data-channel" label="Where they talked to the agent">
          <Select
            value={channelId}
            onValueChange={(value) => {
              setChannelId(value)
              setShown(null)
              setErased(null)
            }}
          >
            <SelectTrigger id="visitor-data-channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All channels</SelectItem>
              {people.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          id="visitor-data-id"
          label={hint.label}
          hint={hint.hint}
          error={touched && !trimmed ? 'Say who to look up.' : undefined}
          required
        >
          <Input
            value={identifier}
            placeholder={hint.placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setIdentifier(event.target.value)}
          />
        </Field>
      </FormSection>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {erased ? (
        <div data-testid="visitor-data-erased">
        <FormSection title="Deleted">
          <p className="text-sm text-muted-foreground" role="status">
            Removed {heldLine(erased.removed)} for {erased.request.id} {where(erased.request)}. The deletion is in the audit log,
            without their details.
            {erased.removed.memoriesPending > 0
              ? ` ${pluralized(erased.removed.memoriesPending, 'memory', 'memories')} kept in an outside memory service could not be reached yet; almyty keeps trying every hour.`
              : ''}
          </p>
        </FormSection>
        </div>
      ) : null}

      {shown && !shown.summary.found ? (
        <EmptyState
          variant="panel"
          icon={UserX}
          title={`Nothing kept for ${shown.request.id}`}
          description="Check how the channel writes it: a Slack member id is not a display name, and a phone number needs its country code."
        />
      ) : null}

      {shown?.summary.found ? (
        <FormSection
          title={`What ${agent.name} keeps about ${shown.request.id}`}
          description={
            shown.summary.firstAt && shown.summary.lastAt
              ? `First message ${formatDate(shown.summary.firstAt)}, last ${formatDate(shown.summary.lastAt)}.`
              : undefined
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="visitor-data-found-on">
            <span className="text-muted-foreground">Found on</span>
            {shown.summary.channels.map((c) => (
              <Badge key={c.id} variant="outline" className="gap-1.5">
                <ChannelIcon type={c.type} />
                {c.name}
              </Badge>
            ))}
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3" data-testid="visitor-data-summary">
            <Held label="Conversations" value={shown.summary.conversations} />
            <Held label="Messages" value={shown.summary.messages} />
            <Held label="Memories" value={shown.summary.memories} />
            <Held label="Files" value={shown.summary.files} />
            <Held label="Saved replies" value={shown.summary.storedReplies} />
            <Held label="Runs" value={shown.summary.runs} />
          </dl>
          {shown.summary.recent.length > 0 ? (
            <DataTable
              columns={CONVERSATION_COLUMNS}
              data={shown.summary.recent}
              hideSelectionCount
              hideColumnsButton
              hidePaginationWhenSinglePage
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => download.mutate(shown.request)} disabled={download.isPending}>
              <Download className="mr-2 h-4 w-4" aria-hidden="true" />
              {download.isPending ? 'Preparing…' : 'Download their data'}
            </Button>
            <Button type="button" variant="destructive" onClick={onErase} disabled={erase.isPending}>
              <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
              {erase.isPending ? 'Deleting…' : 'Delete their data'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The download is a file to send them. Deleting removes their conversations, messages, files and memories on these
            channels, and cannot be undone. Both are recorded in the audit log, without their details.
          </p>
        </FormSection>
      ) : null}
    </FormPage>
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
