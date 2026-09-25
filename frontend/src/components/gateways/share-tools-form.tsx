import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, Search } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { ChoiceTile, ChoiceTiles } from '@/components/connect/service-tiles'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import type { VisibilityValue } from '@/components/ui/visibility-field'
import { WhoCanUse } from '@/components/connect/who-can-use'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { gatewaysApi } from '@/lib/api'
import { captureEvent } from '@/lib/analytics'
import { getApiErrorMessage } from '@/lib/api-error'
import { gatewayBackendUrl, orgSlugOf } from '@/lib/gateway-connect'
import { toolsQuery } from '@/lib/list-queries'
import { readableToolName } from '@/lib/tool-names'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'

/** How many tool rows the list shows before asking for a search. */
const SHOWN_TOOLS = 50

export interface ShareableTool {
  id: string
  name: string
  description?: string | null
  status?: string
  visibility?: 'org' | 'team' | 'private' | null
  teamId?: string | null
  apiId?: string | null
  api?: { id: string; name: string } | null
  /** The operation a spec-imported tool came from; its name is the spec's summary when there is one. */
  operation?: { name?: string | null; api?: { id: string; name: string } | null } | null
}

export interface ToolSource {
  id: string
  name: string
  tools: ShareableTool[]
}

/** The API a tool came from, whichever way the list carries it. */
export function sourceOf(tool: ShareableTool): { id: string; name: string } | null {
  const api = tool.api ?? tool.operation?.api ?? null
  return api?.id ? { id: api.id, name: api.name } : null
}

/** Only an active tool can be served; a draft is shown but can't be picked. */
export const isShareable = (tool: ShareableTool) => (tool.status ?? 'active') === 'active'

/** The tools grouped by the API they came from, biggest first. */
export function toolSources(tools: ShareableTool[]): ToolSource[] {
  const byId = new Map<string, ToolSource>()
  for (const tool of tools) {
    const source = sourceOf(tool)
    if (!source) continue
    const entry = byId.get(source.id) ?? { ...source, tools: [] }
    entry.tools.push(tool)
    byId.set(source.id, entry)
  }
  return [...byId.values()].sort((a, b) => b.tools.length - a.tools.length || a.name.localeCompare(b.name))
}

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

/**
 * Who a share can be for, from what is in it. A gateway may not serve a
 * tool more widely than the tool itself is visible, so a private tool makes
 * the share private and tools of one team make it that team's. Anything
 * the person picks by hand wins.
 */
export function scopeFor(tools: ShareableTool[]): VisibilityValue {
  if (tools.some((t) => t.visibility === 'private')) return { visibility: 'private', teamId: null }
  const teams = new Set(tools.filter((t) => t.visibility === 'team').map((t) => t.teamId ?? ''))
  if (teams.size === 1) {
    const [teamId] = [...teams]
    if (teamId) return { visibility: 'team', teamId }
  }
  return { visibility: 'org', teamId: null }
}

/** The name a share starts with: the API when all tools are one API's, else the first tool. */
export function defaultShareName(picked: ShareableTool[]): string {
  if (picked.length === 0) return ''
  const sources = new Set(picked.map((t) => sourceOf(t)?.id ?? `tool:${t.id}`))
  if (sources.size === 1) {
    const source = sourceOf(picked[0])
    if (source) return source.name
  }
  const first = readableToolName(picked[0])
  return picked.length === 1 ? first : `${first} and ${picked.length - 1} more`
}

/**
 * Share tools: pick tools, or a whole API, and get one address that works
 * in every client. The only question is what to share; the name, the path,
 * who it is for and the access key follow from the pick and can be changed
 * under Advanced. The one address speaks MCP, UTCP and Skills, so there is
 * no protocol to choose.
 */
export function ShareToolsForm() {
  const { currentOrganization } = useOrganizationStore()
  const { error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()

  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [path, setPath] = useState('')
  const [pathTouched, setPathTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [scopeTouched, setScopeTouched] = useState(false)
  const [pickError, setPickError] = useState<string | undefined>()
  const [nameError, setNameError] = useState<string | undefined>()

  const guard = useLeaveGuard(picked.size > 0 || nameTouched || pathTouched || description !== '')

  const toolsQ = useQuery({ ...toolsQuery(currentOrganization?.id), enabled: !!currentOrganization })
  const tools = useMemo(() => (toolsQ.data?.items ?? []) as ShareableTool[], [toolsQ.data])
  const sources = useMemo(() => toolSources(tools), [tools])
  const byId = useMemo(() => new Map(tools.map((t) => [t.id, t])), [tools])
  const pickedTools = useMemo(() => [...picked].map((id) => byId.get(id)).filter(Boolean) as ShareableTool[], [picked, byId])

  // A link can open the page with an API or a tool already picked.
  const preApi = searchParams.get('api')
  const preTool = searchParams.get('tool')
  useEffect(() => {
    if (tools.length === 0 || picked.size > 0) return
    const initial = tools.filter((t) => isShareable(t) && ((preApi && sourceOf(t)?.id === preApi) || (preTool && t.id === preTool)))
    if (initial.length > 0) setPicked(new Set(initial.map((t) => t.id)))
    // Only on first load of the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools.length])

  // Name, path and scope follow the pick until someone sets them.
  const suggestedName = defaultShareName(pickedTools)
  const effectiveName = nameTouched ? name : suggestedName
  const effectivePath = pathTouched ? path : `/${slugOf(effectiveName)}`
  const effectiveScope = scopeTouched ? scope : scopeFor(pickedTools)
  const orgSlug = orgSlugOf(currentOrganization)
  const address = `${gatewayBackendUrl()}/${orgSlug}${effectivePath}`

  const q = search.trim().toLowerCase()
  const shownSources = q ? sources.filter((s) => s.name.toLowerCase().includes(q)) : sources
  const matchingTools = q
    ? tools.filter((t) => [t.name, readableToolName(t), t.description ?? '', sourceOf(t)?.name ?? ''].some((s) => s.toLowerCase().includes(q)))
    : tools
  const shownTools = matchingTools.slice(0, SHOWN_TOOLS)
  const pickedIn = (source: ToolSource) => source.tools.filter((t) => picked.has(t.id)).length
  // A picked API shows as one line that opens into its tools, not as a list of all of them.
  const pickedSources = sources.filter((s) => pickedIn(s) > 0)
  // Tools that came from no API (written by hand) have no API to pick, so they are listed.
  const looseTools = tools.filter((t) => !sourceOf(t))

  const toggleTool = (id: string) => {
    setPickError(undefined)
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const sourceState = (source: ToolSource): 'all' | 'some' | 'none' => {
    const ready = source.tools.filter(isShareable)
    const n = ready.filter((t) => picked.has(t.id)).length
    return n === 0 ? 'none' : n === ready.length ? 'all' : 'some'
  }

  const toggleSource = (source: ToolSource) => {
    setPickError(undefined)
    const ready = source.tools.filter(isShareable).map((t) => t.id)
    const all = sourceState(source) === 'all'
    setPicked((prev) => {
      const next = new Set(prev)
      for (const id of ready) {
        if (all) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const share = useMutation({
    mutationFn: (payload: Record<string, unknown>) => gatewaysApi.create(payload),
    onSuccess: async (gateway: any) => {
      captureEvent('gateway_deployed')
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      guard.leave(gateway?.id ? `/gateways/${gateway.id}` : '/gateways', {
        state: { initialApiKey: gateway?.initialApiKey, sharedTools: gateway?.sharedTools },
      })
    },
    onError: (err: unknown) => errorNotif('Could not share these tools', getApiErrorMessage(err, 'Please try again.')),
  })

  const onSubmit = () => {
    let ok = true
    if (picked.size === 0) {
      setPickError('Pick at least one tool, or an API.')
      ok = false
    }
    if (!effectiveName.trim()) {
      setNameError('Give it a name.')
      ok = false
    } else setNameError(undefined)
    if (!ok) return
    share.mutate({
      name: effectiveName.trim().slice(0, 100),
      type: 'tools',
      kind: 'tool',
      endpoint: effectivePath,
      description: description || undefined,
      configuration: {},
      visibility: effectiveScope.visibility,
      teamId: effectiveScope.teamId,
      toolIds: [...picked],
    })
  }

  const count = picked.size
  const whoSummary = { org: 'everyone in your organization', team: 'one team', private: 'only you' }[effectiveScope.visibility]

  return (
    <FormPage
      title="Share tools"
      description="Pick tools and get one address that works in Claude Code, Cursor and any MCP, UTCP or Skills client."
      back={{ to: '/gateways', label: 'Gateways' }}
      guard={guard}
      width="wide"
      submitLabel={count > 0 ? `Share ${count} tool${count === 1 ? '' : 's'}` : 'Share tools'}
      submitting={share.isPending}
      onSubmit={onSubmit}
    >
      <FormSection title="What to share" description="A whole API, or single tools: search to find one. Drafts can't be shared until they are active.">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search APIs and tools" aria-label="Search APIs and tools" />
        </div>

        {toolsQ.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : tools.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="share-no-tools">
            You have no tools yet. Import an API or write a tool first.
          </p>
        ) : (
          <>
            {shownSources.length > 0 && (
              <section aria-labelledby="share-apis" className="space-y-2">
                <h3 id="share-apis" className="text-sm font-medium text-muted-foreground">
                  APIs
                </h3>
                <ChoiceTiles>
                  {shownSources.map((source) => {
                    const state = sourceState(source)
                    const ready = source.tools.filter(isShareable).length
                    const n = pickedIn(source)
                    return (
                      <ChoiceTile
                        key={source.id}
                        testId={`share-api-${source.id}`}
                        icon={<Boxes className="h-4 w-4 text-primary" />}
                        label={source.name}
                        hint={
                          state === 'some'
                            ? `${n} of ${ready} picked`
                            : ready === source.tools.length
                              ? `${ready} tool${ready === 1 ? '' : 's'}`
                              : `${ready} of ${source.tools.length} tools ready`
                        }
                        selected={state === 'all'}
                        disabled={ready === 0}
                        onClick={() => toggleSource(source)}
                      />
                    )
                  })}
                </ChoiceTiles>
              </section>
            )}

            {q ? (
              <section aria-labelledby="share-tools" className="space-y-2">
                <h3 id="share-tools" className="text-sm font-medium text-muted-foreground">
                  Tools
                </h3>
                {shownTools.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tool matches &ldquo;{search}&rdquo;.</p>
                ) : (
                  <ToolRows tools={shownTools} picked={picked} onToggle={toggleTool} showSource />
                )}
                {matchingTools.length > shownTools.length && (
                  <p className="text-xs text-muted-foreground">
                    Showing {shownTools.length} of {matchingTools.length}. Search for more to narrow it down.
                  </p>
                )}
              </section>
            ) : (
              <>
                {pickedSources.map((source) => {
                  const ready = source.tools.filter(isShareable).length
                  const n = pickedIn(source)
                  return (
                    <Disclosure
                      key={source.id}
                      testId={`share-picked-${source.id}`}
                      title={source.name}
                      summary={`${n === ready ? n : `${n} of ${ready}`} tool${ready === 1 ? '' : 's'} · Choose which`}
                      bodyClassName="p-0"
                    >
                      <ToolRows tools={source.tools} picked={picked} onToggle={toggleTool} bare />
                    </Disclosure>
                  )
                })}
                {looseTools.length > 0 && (
                  <section aria-labelledby="share-tools" className="space-y-2">
                    <h3 id="share-tools" className="text-sm font-medium text-muted-foreground">
                      {sources.length > 0 ? 'Other tools' : 'Tools'}
                    </h3>
                    <ToolRows tools={looseTools.slice(0, SHOWN_TOOLS)} picked={picked} onToggle={toggleTool} />
                    {looseTools.length > SHOWN_TOOLS && (
                      <p className="text-xs text-muted-foreground">
                        Showing {SHOWN_TOOLS} of {looseTools.length}. Search to find the rest.
                      </p>
                    )}
                  </section>
                )}
              </>
            )}
          </>
        )}
        {pickError && (
          <p role="alert" className="text-sm text-destructive" data-invalid="true">
            {pickError}
          </p>
        )}
      </FormSection>

      <FormSection>
        <Field id="share-name" label="Name" error={nameError} hint={`Address: ${address}`}>
          <Input
            value={effectiveName}
            placeholder="Weather tools"
            autoComplete="off"
            onChange={(e) => {
              setNameTouched(true)
              setName(e.target.value)
              setNameError(undefined)
            }}
          />
        </Field>
      </FormSection>

      <Disclosure title="Advanced" summary={`Path ${effectivePath} · ${whoSummary} · access key`}>
        <Field id="share-path" label="Path" hint="The last part of the address.">
          <Input
            value={effectivePath}
            autoComplete="off"
            onChange={(e) => {
              setPathTouched(true)
              const v = e.target.value
              setPath(v.startsWith('/') ? v : `/${v}`)
            }}
          />
        </Field>
        <Field id="share-description" label="Description">
          <Textarea rows={2} value={description} placeholder="What these tools are for" onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <WhoCanUse
          value={effectiveScope}
          noun="these tools"
          onChange={(next) => {
            setScopeTouched(true)
            setScope(next)
          }}
        />
        <p className="text-sm text-muted-foreground">
          Every share gets an access key, shown once on the next page. Other sign-in methods, such as OAuth or JWT, can be added there under Advanced.
        </p>
      </Disclosure>
    </FormPage>
  )
}

/**
 * Tools to tick, by the name people read, with the name agents call it by
 * underneath in mono. `showSource` adds the API, for a list that mixes
 * APIs (search results); `bare` drops the border inside a fold.
 */
function ToolRows({
  tools,
  picked,
  onToggle,
  showSource = false,
  bare = false,
}: {
  tools: ShareableTool[]
  picked: Set<string>
  onToggle: (id: string) => void
  showSource?: boolean
  bare?: boolean
}) {
  return (
    <ul className={cn('divide-y', !bare && 'rounded-lg border')}>
      {tools.map((tool) => {
        const ready = isShareable(tool)
        const id = `share-tool-${tool.id}`
        const readable = readableToolName(tool)
        const source = showSource ? sourceOf(tool) : null
        const machine = readable !== tool.name ? tool.name : null
        return (
          <li key={tool.id} className="flex items-center gap-3 px-3 py-2.5">
            <Checkbox id={id} checked={picked.has(tool.id)} disabled={!ready} onCheckedChange={() => onToggle(tool.id)} />
            <label htmlFor={id} className={cn('min-w-0 flex-1 text-sm', ready ? 'cursor-pointer' : 'text-muted-foreground')}>
              <span className="block truncate font-medium">{readable}</span>
              {(source || machine) && (
                <span className="block truncate text-xs text-muted-foreground">
                  {source?.name}
                  {source && machine && ' · '}
                  {machine && <span className="font-mono">{machine}</span>}
                </span>
              )}
            </label>
            {!ready && <Badge variant="secondary">{tool.status === 'draft' ? 'Draft' : tool.status}</Badge>}
          </li>
        )
      })}
    </ul>
  )
}
