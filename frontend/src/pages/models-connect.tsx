import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/layout/page-header'
import { ConnectProviderForm, type ConnectResult } from '@/components/llm-providers/connect-provider-form'
import { PROVIDER_TILE_GROUPS, isProviderType, providerTileLabel } from '@/components/llm-providers/provider-catalog'
import { providerLogos } from '@/components/llm-providers/provider-type-config'
import { cn } from '@/lib/utils'
import { safeReturnTo } from '@/lib/return-to'

/** How many model names the success panel lists before "and N more". */
const SHOWN_MODELS = 8

/**
 * Connect a provider: pick it from the tiles, paste its key, done. Its
 * models show up on /models and in every model chooser. The picked tile
 * lives in the URL (?type=openai) so a link can open straight onto it.
 */
export function ConnectProviderPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<ConnectResult | null>(null)

  const picked = searchParams.get('type')
  const type = isProviderType(picked) ? picked : null
  // Where Done goes: back to the guide or page that sent you, else Models.
  const returnTo = safeReturnTo(searchParams.get('returnTo')) ?? '/models'

  useEffect(() => {
    document.title = 'Connect a provider | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const pick = (next: string | null) => {
    setResult(null)
    const params = new URLSearchParams(searchParams)
    if (next) params.set('type', next)
    else params.delete('type')
    setSearchParams(params)
  }

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    return PROVIDER_TILE_GROUPS.map((g) => ({
      ...g,
      types: q ? g.types.filter((t) => providerTileLabel(t).toLowerCase().includes(q) || t.includes(q)) : g.types,
    })).filter((g) => g.types.length > 0)
  }, [search])

  const onConnected = (next: ConnectResult) => {
    setResult(next)
    // The new provider and its models, everywhere they are listed.
    queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to="/models" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Models
      </Link>
      <PageHeader title="Connect a provider" description="Connect a provider once and its models show up everywhere in almyty." />

      {type ? (
        <Card>
          <CardContent className="space-y-5 pt-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-xl" aria-hidden>
                  {providerLogos[type] || '⚙️'}
                </span>
                <h2 className="text-lg font-semibold">{providerTileLabel(type)}</h2>
              </div>
              {!result && (
                <Button variant="ghost" size="sm" onClick={() => pick(null)}>
                  Choose another provider
                </Button>
              )}
            </div>

            {result ? (
              <ConnectedSummary result={result} onDone={() => navigate(returnTo)} onOpen={() => navigate(`/models/providers/${result.provider.id}`)} />
            ) : (
              <ConnectProviderForm key={type} type={type} onConnected={onConnected} />
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search providers" aria-label="Search providers" />
          </div>
          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No provider matches &ldquo;{search}&rdquo;. If it speaks the OpenAI API, connect it as{' '}
              <button type="button" className="text-primary hover:underline" onClick={() => pick('custom')}>
                your own server
              </button>
              .
            </p>
          )}
          {groups.map((group) => (
            <section key={group.id} aria-labelledby={`tiles-${group.id}`} className="space-y-2">
              <h2 id={`tiles-${group.id}`} className="text-sm font-medium text-muted-foreground">
                {group.title}
              </h2>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {group.types.map((t) => (
                  <li key={t}>
                    <button
                      type="button"
                      data-testid={`provider-tile-${t}`}
                      onClick={() => pick(t)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors',
                        'hover:border-primary/50 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                      )}
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-base" aria-hidden>
                        {providerLogos[t] || '⚙️'}
                      </span>
                      <span className="min-w-0 truncate font-medium">{providerTileLabel(t)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function ConnectedSummary({ result, onDone, onOpen }: { result: ConnectResult; onDone: () => void; onOpen: () => void }) {
  const models = Array.isArray(result.models) ? result.models : []
  const shown = models.slice(0, SHOWN_MODELS)
  const more = models.length - shown.length
  return (
    <div className="space-y-4" data-testid="connect-success">
      <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        {result.provider.name} is connected.{' '}
        {models.length === 0 ? 'It lists no models yet.' : `${models.length} model${models.length === 1 ? '' : 's'} found.`}
      </p>
      {shown.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Models found">
          {shown.map((m) => (
            <li key={m.id} className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs">
              {m.vendorModelId || m.name}
            </li>
          ))}
          {more > 0 && <li className="px-1 py-0.5 text-xs text-muted-foreground">and {more} more</li>}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">Pick any of them in an agent, a tool or a chat.</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onDone}>Done</Button>
        <Button variant="outline" onClick={onOpen}>
          Open provider
        </Button>
      </div>
    </div>
  )
}
