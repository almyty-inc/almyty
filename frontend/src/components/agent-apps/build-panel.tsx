import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Copy, Download, Hammer, Lock, ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNotifications } from '@/store/app'
import { useCopy } from '@/lib/clipboard'
import { credentialsApi } from '@/lib/api'
import { SigningCredentialDialog } from './signing-credential-dialog'
import {
  agentAppsApi,
  formatBytes,
  type AgentApp,
  type AppBuild,
  type DistributionTarget,
} from '@/lib/agent-apps'

export interface BuildPanelProps {
  app: AgentApp
  target: DistributionTarget
  /** The certificate this distribution signs with, if it names one. */
  signingCredentialId?: string | null
  onSigningCredentialChange?: (credentialId: string) => void
}

/** Stands in for "nothing selected", because a Select cannot take ''. */
const UNSIGNED = 'unsigned'

/** Refetch while anything is in flight; stop once nothing is. */
const inFlight = (builds: AppBuild[] | undefined) =>
  (builds ?? []).some((b) => b.status === 'queued' || b.status === 'running')

const STATUS_LABEL: Record<string, string> = {
  queued: 'Waiting to start',
  running: 'Building',
  succeeded: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/**
 * Building an artifact and getting a link to it.
 *
 * The build runs on our machines, so this is a button rather than a
 * command to paste into a terminal. What it cannot hide is what an
 * unsigned artifact does to whoever downloads it, which is shown before
 * the build rather than discovered afterwards.
 */
export function BuildPanel({
  app,
  target,
  signingCredentialId,
  onSigningCredentialChange,
}: BuildPanelProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const copy = useCopy()
  const [platform, setPlatform] = useState<string>('')
  const [addingCertificate, setAddingCertificate] = useState(false)

  const { data: platforms } = useQuery({
    queryKey: ['app-build-platforms', app.slug, target],
    queryFn: () => agentAppsApi.platforms(app.slug, target),
  })

  const { data: builds } = useQuery({
    queryKey: ['app-builds', app.slug],
    queryFn: () => agentAppsApi.builds(app.slug),
    // A build takes tens of seconds, so poll while one is running and
    // stop as soon as none is rather than polling forever.
    refetchInterval: (query) => (inFlight(query.state.data as AppBuild[]) ? 4000 : false),
  })

  const { data: capabilities } = useQuery({
    queryKey: ['app-build-capabilities', app.slug, target],
    queryFn: () => agentAppsApi.capabilities(app.slug, target),
  })

  const { data: certificates } = useQuery({
    queryKey: ['signing-credentials'],
    queryFn: async () => {
      const response: any = await credentialsApi.getAll()
      const all = (response?.data ?? response ?? []) as any[]
      return all.filter((c) => c.type === 'code_signing')
    },
  })

  const forTarget = (builds ?? []).filter((b) => b.target === target)
  const chosen = (platforms ?? []).find((p) => p.id === platform)
  const willSign = Boolean(signingCredentialId)

  // A build records the platform id it was compiled for. Show the name
  // instead, and fall back to the id for a platform we no longer offer
  // rather than leaving the row blank.
  const platformLabel = (id: string | null) =>
    (platforms ?? []).find((p) => p.id === id)?.label ?? id ?? 'unknown platform'

  const start = useMutation({
    mutationFn: () => agentAppsApi.requestBuild(app.slug, { target, platform }),
    onSuccess: () => {
      success('Build started', 'It will appear below when it finishes.')
      queryClient.invalidateQueries({ queryKey: ['app-builds', app.slug] })
    },
    onError: (err: any) =>
      errorNotif('Could not start', err?.response?.data?.message || 'Something went wrong.'),
  })

  const download = useMutation({
    mutationFn: (buildId: string) => agentAppsApi.downloadUrl(app.slug, buildId),
    onSuccess: (url) => {
      // The URL is short lived, so it is fetched at click time and used
      // immediately rather than rendered into the page.
      window.open(url, '_blank', 'noopener')
    },
    onError: (err: any) =>
      errorNotif('Could not download', err?.response?.data?.message || 'Link unavailable.'),
  })

  // What the chosen platform would need signed, and whether this
  // deployment can do it. Read before the build rather than after.
  const signingHere = capabilities?.signing.find((s) => s.kind === chosen?.signing?.kind)

  return (
    <div className="space-y-4">
      {capabilities && !capabilities.canBuild && (
        <p className="flex gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-xs text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{capabilities.buildReason}</span>
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="build-platform">Build for</Label>
        <Select value={platform} onValueChange={setPlatform}>
          <SelectTrigger id="build-platform">
            <SelectValue placeholder="Choose a platform" />
          </SelectTrigger>
          <SelectContent>
            {(platforms ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {chosen?.signing && !willSign && (
        // Said before the build, because the moment to learn that macOS
        // will refuse to open this is not after sending out the link.
        <div className="space-y-2 rounded-md border border-amber-400 bg-amber-50 p-3 dark:bg-amber-950">
          <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-300">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span>{chosen.unsignedConsequence}</span>
          </p>
          <p className="text-[11px] text-amber-700/80 dark:text-amber-300/80">
            To sign it, add {chosen.signing.needs.join(' and ')} to your credentials.{' '}
            {chosen.signing.note}
          </p>
        </div>
      )}

      {signingHere && !signingHere.ready && (
        // A host can compile perfectly well and still not be able to
        // sign, which is a different problem with a different fix.
        <p className="flex gap-2 rounded-md border border-amber-400 bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{signingHere.reason}</span>
        </p>
      )}

      {chosen?.signing && signingHere?.ready !== false && onSigningCredentialChange && (
        <div className="space-y-1.5">
          <Label htmlFor="build-signing">Sign with</Label>
          <Select
            value={signingCredentialId || UNSIGNED}
            onValueChange={(value) =>
              value === 'new'
                ? setAddingCertificate(true)
                : onSigningCredentialChange(value === UNSIGNED ? '' : value)
            }
          >
            <SelectTrigger id="build-signing">
              <SelectValue placeholder="Nothing, ship it unsigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSIGNED}>Nothing, ship it unsigned</SelectItem>
              {(certificates ?? []).map((c: any) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
              <SelectItem value="new">Add a certificate...</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {chosen?.signing && (
        <SigningCredentialDialog
          open={addingCertificate}
          onOpenChange={setAddingCertificate}
          kind={chosen.signing.kind}
          onCreated={(id) => onSigningCredentialChange?.(id)}
        />
      )}

      <Button
        className="w-full"
        disabled={!platform || start.isPending || capabilities?.canBuild === false}
        onClick={() => start.mutate()}
      >
        <Hammer className="mr-2 h-4 w-4" />
        {start.isPending ? 'Starting...' : 'Build'}
      </Button>

      {forTarget.length > 0 && (
        <div className="space-y-2">
          <Label>Builds</Label>
          <ul className="space-y-2">
            {forTarget.slice(0, 8).map((build) => (
              <li key={build.id} className="rounded-md border p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">
                    {platformLabel(build.platform)}
                    {build.version ? ` · v${build.version}` : ''}
                  </span>
                  <span
                    className={
                      build.status === 'succeeded'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : build.status === 'failed'
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                    }
                  >
                    {STATUS_LABEL[build.status] ?? build.status}
                  </span>
                </div>

                {build.status === 'succeeded' && (
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={download.isPending}
                      onClick={() => download.mutate(build.id)}
                    >
                      <Download className="mr-1.5 h-3 w-3" />
                      Download
                    </Button>
                    <span className="text-muted-foreground">{formatBytes(build.artifactBytes)}</span>
                    {build.signed ? (
                      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                        <Lock className="h-3 w-3" />
                        Signed
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="h-3 w-3" />
                        Unsigned
                      </span>
                    )}
                  </div>
                )}

                {build.error && (
                  <p className="mt-2 break-words text-destructive">{build.error}</p>
                )}

                {/* What whoever receives this will meet. Shipping
                    unsigned is a choice, not a failure, so this is the
                    instruction they need rather than a warning about
                    something being wrong. */}
                {build.handoff && !build.error && (
                  <div className="mt-2 space-y-1.5 rounded-md border bg-muted/40 p-2">
                    <p className="text-muted-foreground">{build.handoff.summary}</p>

                    {build.handoff.command && (
                      <>
                        <div className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[11px]">
                            {build.handoff.command}
                          </code>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 shrink-0"
                            onClick={() => copy(build.handoff!.command!, 'Command copied')}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {build.handoff.commandNote}
                        </p>
                      </>
                    )}
                  </div>
                )}

                {/* Only when something could have been signed and was
                    not for a reason the operator can act on. */}
                {build.signingNote && !build.error && !build.handoff && (
                  <p className="mt-2 break-words text-amber-600 dark:text-amber-400">
                    {build.signingNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
