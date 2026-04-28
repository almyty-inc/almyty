/**
 * SchemaTab — read-only viewer for the stored API schema.
 *
 * Renders rawSchema by default (the original text/JSON/XML/proto).
 * If the user wants the parsed object form, the "Parse" button hits
 * the on-demand parse endpoint — the parsed view is no longer kept
 * in DB (used to live as `processedSchema`, dropped because it was
 * 8-15 MB of duplicate state per import for a feature the UI calls
 * maybe once per API).
 */
import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apisApi } from '@/lib/api'
import { Api } from '@/types'

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
      setError(e?.response?.data?.message || e?.message || 'Failed to parse schema')
    } finally {
      setLoading(false)
    }
  }

  const display =
    view === 'parsed' && parsed
      ? JSON.stringify(parsed, null, 2)
      : rawText

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Schema Content</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 mb-2">
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
        <div className="bg-muted p-4 rounded max-h-[60vh] overflow-y-auto">
          <pre className="text-xs whitespace-pre-wrap break-words">{display}</pre>
        </div>
      </DialogContent>
    </Dialog>
  )
}
