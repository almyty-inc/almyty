import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export interface ReadinessResult { ready: boolean; message?: string }

export function ReadinessBanner({ result, pending, failed, onRetry, onConfigure }: {
  result?: ReadinessResult; pending: boolean; failed: boolean; onRetry: () => void; onConfigure: () => void
}) {
  if (pending) return <p role="status" className="text-sm text-muted-foreground">Checking model setup before activation…</p>
  if (result?.ready && !failed) return null
  return (
    <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 space-y-2">
      <p className="font-medium">{failed ? 'Could not check model setup' : 'Not ready to activate'}</p>
      <p className="text-sm">{failed ? 'The readiness check failed. Retry before activating this agent.' : result?.message}</p>
      <div className="flex flex-wrap items-center gap-3">
        {!failed && <><Link className="text-sm underline" to="/models">Open Models</Link><Button size="sm" variant="outline" onClick={onConfigure}>Configure execution</Button></>}
        <Button size="sm" variant="outline" onClick={onRetry}>Recheck setup</Button>
      </div>
    </div>
  )
}
