/**
 * Memory: where an autonomous agent's memories are kept, whose memory it
 * is, what gets saved (and what never is), and how long it is kept. Every
 * field is enforced by the server (agent-memory-settings.ts,
 * AgentMemoryKeeper); nothing here is only shown.
 *
 * The account is almyty's own memory, an outside memory account the
 * organization set up, or one of the agent's own: anyone who can edit the
 * agent can pick or create one right here, with the same credential picker
 * the Memory page uses.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { AddMemoryAccountFlow } from '@/components/memory/memory-accounts'
import { useConnectionOptions } from '@/components/connections/connection-select'
import { memoryBackendName } from '@/components/memory/memory-words'
import { memoriesApi } from '@/lib/api'
import type { Connection } from '@/types/connections'
import type { AgentMemoryConfig, MemoryAccount, MemorySave, MemoryWhose } from '@/types/agent-models'

export const NATIVE_MEMORY_ACCOUNT = 'almyty-native'
const NATIVE: MemoryAccount = { id: NATIVE_MEMORY_ACCOUNT, name: 'almyty', canExpire: true, expiresItself: true }

export const WHOSE_LABELS: Record<MemoryWhose, string> = {
  person: 'Each person has their own',
  agent: "This agent's own",
  shared: 'Shared by all agents',
}
const WHOSE_HINTS: Record<MemoryWhose, string> = {
  person: "Each person the agent talks to has a memory of their own. A visitor's is kept only when the agent's visitor settings allow it.",
  agent: 'Only this agent reads and writes it.',
  shared: 'Every agent with shared memory reads and writes the same memory.',
}
export const SAVE_LABELS: Record<MemorySave, string> = {
  facts: 'Facts it learns',
  conversations: 'Whole conversations',
  asked: 'Only when asked',
}
const SAVE_HINTS: Record<MemorySave, string> = {
  facts: "After each conversation, the agent's main model picks out the facts worth keeping.",
  conversations: 'Each exchange is kept as it was said.',
  asked: 'The agent saves something only when the person asks it to remember it.',
}

/** The account list the agent page offers: almyty's own first, whatever the server says. */
export function useMemoryAccounts() {
  return useQuery<MemoryAccount[]>({
    queryKey: ['memories', 'accounts'],
    queryFn: async () => {
      const list = (await memoriesApi.listAccounts()) as MemoryAccount[] | undefined
      const rest = (Array.isArray(list) ? list : []).filter((a) => a.id !== NATIVE_MEMORY_ACCOUNT)
      return [NATIVE, ...rest]
    },
  })
}

/** "What gets saved" as the page shows it, reading the old auto-save switch. */
export function saveOf(config: AgentMemoryConfig): MemorySave {
  return config.save ?? (config.autoSave ? 'facts' : 'asked')
}

/** Everything that would stop a save of this section, one sentence each. */
export function memoryProblems(config: AgentMemoryConfig): string[] {
  if (!config.enabled) return []
  const days = config.retentionDays
  if (days !== undefined && days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    return ['Memory: keep memories for 1 to 3650 days, or until deleted']
  }
  return []
}

export interface MemorySectionProps {
  value: AgentMemoryConfig
  onChange: (next: AgentMemoryConfig) => void
}

/** The Select value of the agent's own account (a connection of its own). */
const CONNECTION_PREFIX = 'connection:'

export function MemorySection({ value, onChange }: MemorySectionProps) {
  const accountsQ = useMemoryAccounts()
  const accounts = accountsQ.data ?? [NATIVE]
  const servicesQ = useMemoryServices()
  const [justConnected, setJustConnected] = useState<Connection | null>(null)
  const accountId = value.account || NATIVE_MEMORY_ACCOUNT
  const ownConnection = value.credentialId || null
  const connectionOptions = useConnectionOptions({ kind: 'memory' })
  const connections = justConnected && !connectionOptions.connections.some(c => c.id === justConnected.id)
    ? [justConnected, ...connectionOptions.connections] : connectionOptions.connections
  const ownName = connections.find(c => c.id === ownConnection)?.name
  // The account in use: the agent's own connection for a service, or the organization's.
  const account: MemoryAccount | undefined = ownConnection
    ? {
        id: accountId,
        name: `${memoryBackendName(accountId)}${ownName ? `: ${ownName}` : ''}`,
        canExpire: servicesQ.data?.find((b) => b.id === accountId)?.canExpire ?? true,
        expiresItself: false,
      }
    : accounts.find((a) => a.id === accountId)
  const whose = value.whose ?? 'shared'
  const save = saveOf(value)
  // A number, even one being typed (0 while the box is empty), means "for a number of days".
  const keepsForDays = typeof value.retentionDays === 'number'
  const set = (patch: Partial<AgentMemoryConfig>) => {
    const next = { ...value, ...patch }
    // `save` says it now; the old switch follows so older readers agree.
    if ('save' in patch) next.autoSave = patch.save === 'facts'
    onChange(next)
  }

  return (
    <Card data-testid="memory-card">
      <CardHeader>
        <CardTitle className="text-base">Memory</CardTitle>
        <CardDescription className="text-xs">What the agent remembers between conversations, and for whom.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="memory-enabled" className="text-sm font-medium">Remember between conversations</Label>
            <p className="text-xs text-muted-foreground">Before it answers, the agent looks up what it saved earlier.</p>
          </div>
          <Switch id="memory-enabled" checked={!!value.enabled} onCheckedChange={(enabled) => set({ enabled })} />
        </div>

        {value.enabled && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="memory-fields">
            <div className="space-y-1.5">
              <Label htmlFor="memory-account">Keep memories in</Label>
              <Select
                value={ownConnection ? `${CONNECTION_PREFIX}${ownConnection}` : accountId}
                onValueChange={(v) => {
                  if (v.startsWith(CONNECTION_PREFIX)) {
                    const connection = connections.find(c => c.id === v.slice(CONNECTION_PREFIX.length))
                    if (connection) {
                      const backend = connection.connectorKey
                      const canExpire = servicesQ.data?.find(b => b.id === backend)?.canExpire ?? true
                      set({ account: backend, credentialId: connection.id, ...(canExpire ? {} : { retentionDays: null }) })
                    }
                    return
                  }
                  const next = accounts.find((a) => a.id === v)
                  // The organization's account for a service; a time limit it cannot keep is not carried over.
                  set({ account: v, credentialId: null, ...(next && !next.canExpire ? { retentionDays: null } : {}) })
                }}
              >
                <SelectTrigger id="memory-account"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                  {connections.map(c => <SelectItem key={c.id} value={`${CONNECTION_PREFIX}${c.id}`}>{c.name} ({memoryBackendName(c.connectorKey)})</SelectItem>)}
                  {ownConnection && !connections.some(c => c.id === ownConnection) && <SelectItem value={`${CONNECTION_PREFIX}${ownConnection}`}>{account?.name} (unavailable)</SelectItem>}
                  {!ownConnection && !account && <SelectItem value={accountId}>{memoryBackendName(accountId)} (not set up)</SelectItem>}
                </SelectContent>
              </Select>
              <AddMemoryAccount
                onAdded={(service, connection) => {
                  setJustConnected(connection)
                  const canExpire = servicesQ.data?.find((b) => b.id === service)?.canExpire ?? true
                  set({ account: service, credentialId: connection.id, ...(canExpire ? {} : { retentionDays: null }) })
                }}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="memory-whose">Whose memory</Label>
              <Select value={whose} onValueChange={(v) => set({ whose: v as MemoryWhose })}>
                <SelectTrigger id="memory-whose"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(WHOSE_LABELS) as MemoryWhose[]).map((k) => (
                    <SelectItem key={k} value={k}>{WHOSE_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{WHOSE_HINTS[whose]}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="memory-save">What it saves</Label>
              <Select value={save} onValueChange={(v) => set({ save: v as MemorySave })}>
                <SelectTrigger id="memory-save"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(SAVE_LABELS) as MemorySave[]).map((k) => (
                    <SelectItem key={k} value={k}>{SAVE_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{SAVE_HINTS[save]}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="memory-retention">How long it keeps memories</Label>
              <div className="flex items-center gap-2">
                <Select
                  value={keepsForDays ? 'days' : 'forever'}
                  onValueChange={(v) => set({ retentionDays: v === 'days' ? 30 : null })}
                >
                  <SelectTrigger id="memory-retention" className="flex-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="forever">Until deleted</SelectItem>
                    <SelectItem value="days" disabled={account ? !account.canExpire : false}>For a number of days</SelectItem>
                  </SelectContent>
                </Select>
                {keepsForDays && (
                  <Input
                    aria-label="Days to keep a memory"
                    type="number"
                    min={1}
                    max={3650}
                    className="w-24"
                    value={value.retentionDays || ''}
                    // Emptied while typing: 0, which Save refuses until a number is there.
                    onChange={(e) => set({ retentionDays: e.target.value === '' ? 0 : Number(e.target.value) })}
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground" data-testid="memory-retention-hint">
                {retentionHint(account, keepsForDays)}
              </p>
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="memory-never-save">Never save</Label>
              <Textarea
                id="memory-never-save"
                rows={3}
                placeholder={'Payment details\nHealth information'}
                value={value.neverSave ?? ''}
                onChange={(e) => set({ neverSave: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                One rule per line. Before anything is saved, the agent's main model takes out what these rules cover.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function retentionHint(account: MemoryAccount | undefined, keepsForDays: boolean): string {
  if (account && !account.canExpire) return `${account.name} has no way to delete one memory, so memories there are kept until deleted there.`
  if (!keepsForDays) return 'Memories stay until someone deletes them on the Memory page.'
  if (account && !account.expiresItself) return `almyty deletes them from ${account.name} once they are older than that, about once an hour.`
  return 'A memory older than that is no longer used or shown. A change applies to what the agent already saved.'
}

/**
 * "Add a memory account" in place: pick the service, then pick or create
 * an account with the same credential picker the Memory page uses, and it
 * becomes this agent's own account for that service. Anyone who can edit
 * the agent may do it; the new connection's own scope decides who can use
 * it, and the server refuses one the agent's scope does not cover.
 */
function AddMemoryAccount({ onAdded }: { onAdded: (service: string, connection: Connection) => void }) {
  const [open, setOpen] = useState(false)
  const [service, setService] = useState<string | null>(null)
  const backendsQ = useMemoryServices(open)
  const services = (backendsQ.data ?? []).filter(b => b.id !== NATIVE_MEMORY_ACCOUNT && b.modes.includes('memory'))
  if (!open) return <Button type="button" variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => setOpen(true)}>Connect account</Button>
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="add-memory-account">
      <AddMemoryAccountFlow
        services={services}
        service={service}
        onPickService={setService}
        embedded
        onConnected={connection => {
          onAdded(connection.connectorKey, connection)
          setOpen(false)
          setService(null)
        }}
        onCancel={() => setOpen(false)}
      />
      {!service && <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>}
    </div>
  )
}

/** Every memory service, with whether a memory there can be given a time limit. */
function useMemoryServices(enabled = true) {
  return useQuery<Array<{ id: string; modes: string[]; canExpire?: boolean }>>({
    queryKey: ['memories', 'backends'],
    queryFn: async () => {
      const list = await memoriesApi.listBackends()
      return Array.isArray(list) ? list : []
    },
    enabled,
  })
}
