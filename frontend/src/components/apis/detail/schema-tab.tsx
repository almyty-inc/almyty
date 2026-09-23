/**
 * SchemaTab — read-only viewer for the stored API schema, inline on the
 * API detail page.
 *
 * "View" on the overview's Schema row opens this section in place (and
 * scrolls to it); Close folds it away again. Renders rawSchema by default
 * (the original text/JSON/XML/proto). If the user wants the parsed object
 * form, the "Parsed" button hits the on-demand parse endpoint — the parsed
 * view is no longer kept in DB (used to live as `processedSchema`, dropped
 * because it was 8-15 MB of duplicate state per import for a feature the
 * UI calls maybe once per API).
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { apisApi } from '@/lib/api'
import { Api } from '@/types'
import { getApiErrorMessage } from '@/lib/api-error'

interface SchemaTabProps {
  api: Api
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SchemaTab({ api, open, onOpenChange }: SchemaTabProps) {
  const [view, setView] = useState<'raw' | 'parsed'>('raw')
  const [parsed, setParsed] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sectionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) sectionRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [open])

  if (!open) return null

  const schema = api.schemas?.[0]
  // rawSchema is always a string; older deployments populated `content` so
  // keep it as a fallback until those migrate out.
  const rawText = (schema?.rawSchema || (schema as any)?.content || '') as string

  const loadParsed = async () => {
    if (!schema?.id) return
    setLoading(true)
    setError(null)
    try {
      const data = await apisApi.getParsedSchema(api.id, schema.id)
      setParsed(data)
      setView('parsed')
    } catch (e: any) {
      setError(getApiErrorMessage(e, 'Failed to parse schema'))
    } finally {
      setLoading(false)
    }
  }

  const display =
    view === 'parsed' && parsed
      ? JSON.stringify(parsed, null, 2)
      : rawText

  return (
    <Card ref={sectionRef} id="api-schema" data-testid="api-schema-viewer">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">Schema content</CardTitle>
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} aria-label="Close schema content">
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={view === 'raw' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setView('raw')}
          >
            Raw
          </Button>
          <Button
            variant={view === 'parsed' ? 'default' : 'ghost'}
            size="sm"
            onClick={parsed ? () => setView('parsed') : loadParsed}
            disabled={loading || !schema?.id}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Parsed
          </Button>
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
        <div className="rounded bg-muted p-4">
          <pre className="text-xs whitespace-pre-wrap break-words">{display}</pre>
        </div>
      </CardContent>
    </Card>
  )
}
