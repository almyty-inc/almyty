import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { useAuthStore } from '@/store/auth'
import { runnersApi } from '@/lib/api'
import { RUNNER_HEARTBEAT_POLL_MS, RUNNER_INSTALL_COMMAND, RUNNER_LOGIN_COMMAND, runnerStartCommand } from './runners-shared'

interface Runner { id: string; name: string; state: string; ownerUserId?: string }

/** Starting the daemon creates its record; opening this page never creates a runner. */
export function RunnerNewPage() {
  const { currentOrganization } = useOrganizationStore()
  const { user } = useAuthStore()
  useEffect(() => {
    document.title = 'Start a runner | almyty'
    return () => { document.title = 'almyty' }
  }, [])
  const runners = useQuery<Runner[]>({
    queryKey: ['runners', currentOrganization?.id],
    queryFn: () => runnersApi.getAll(),
    enabled: !!currentOrganization,
    refetchInterval: RUNNER_HEARTBEAT_POLL_MS,
  })
  const ownRunner = runners.data?.find(r => !!user?.id && r.ownerUserId === user.id)
  return (
    <div className="space-y-6">
      <Link to="/runners" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />Runners
      </Link>
      <div>
        <h1 className={DETAIL_TITLE_CLASSES}>Start a runner</h1>
        <p className="mt-1 text-sm text-muted-foreground">Run work on a machine you own. Open a terminal on that machine and run these commands.</p>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Connect this machine</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <CommandBlock label="Install once" command={RUNNER_INSTALL_COMMAND} />
          <CommandBlock label="Log in" command={RUNNER_LOGIN_COMMAND} hint="Sign in as yourself. If you belong to more than one organization, choose which one to use." />
          <CommandBlock label="Start the runner" command={runnerStartCommand()} hint="Keep this terminal open while the runner is running. Work runs as your user on this machine." />
          <p className="text-sm text-muted-foreground">Your runner takes the machine's hostname automatically. You can rename it and change who can use it on its runner page. Labels are available there under Advanced.</p>
          {ownRunner ? (
            <p className="rounded-md border p-3 text-sm">
              Your runner <Link className="font-medium underline underline-offset-4" to={`/runners/${ownRunner.id}`}>{ownRunner.name}</Link> is {ownRunner.state}.
              {' '}Each account can have one runner. Starting it again reconnects that runner.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Once connected, your machine appears on the <Link className="underline underline-offset-4" to="/runners">Runners page</Link>.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CommandBlock({ label, command, hint }: { label: string; command: string; hint?: string }) {
  const { success } = useNotifications()
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      success('Copied', 'Command copied to clipboard')
    } catch { /* The command remains selectable if clipboard access is unavailable. */ }
  }
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-2 flex items-center gap-2 rounded border bg-muted/40 px-3 py-2 font-mono text-xs">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">{command}</code>
        <Button type="button" variant="ghost" size="icon" onClick={onCopy} className="shrink-0" aria-label={`Copy ${label.toLowerCase()} command`} title="Copy command"><Copy className="h-3.5 w-3.5" /></Button>
      </div>
    </div>
  )
}
