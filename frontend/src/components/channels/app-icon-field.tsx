/**
 * The app icon on Branding and visitor rules: upload one, see it, remove
 * it. The picked image becomes a square PNG (lib/app-icon.ts) and goes to
 * the organization's files; the branding keeps the file's id, and desktop
 * builds wear it. Nothing is saved until the page is.
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ImageIcon, Loader2, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { filesApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { APP_ICON_SIDE, APP_ICON_TYPES, AppIconError, appIconProblem, toSquarePng } from '@/lib/app-icon'

export interface AppIconFieldProps {
  id: string
  /** The uploaded icon's file id, or null for none. */
  value: string | null
  onChange: (fileId: string | null) => void
  /** The agent the icon is filed under. */
  agentId?: string
}

/** A preview address for a stored icon: its bytes, fetched with the session, as an image. */
function useStoredIconUrl(fileId: string | null, local: { fileId: string; url: string } | null): string | null {
  const needed = !!fileId && local?.fileId !== fileId
  const query = useQuery({
    queryKey: ['app-icon', fileId],
    queryFn: async () => {
      const res: any = await filesApi.download(fileId!)
      return new Blob([res.data], { type: 'image/png' })
    },
    enabled: needed,
    staleTime: Infinity,
  })
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!needed || !query.data) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(query.data)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [needed, query.data])
  if (!fileId) return null
  return local?.fileId === fileId ? local.url : url
}

export function AppIconField({ id, value, onChange, agentId }: AppIconFieldProps) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // The icon just uploaded, shown from memory rather than fetched back.
  const [local, setLocal] = useState<{ fileId: string; url: string } | null>(null)
  useEffect(() => () => {
    if (local) URL.revokeObjectURL(local.url)
  }, [local])
  const preview = useStoredIconUrl(value, local)

  const choose = async (file: File | undefined) => {
    if (!file) return
    setProblem(null)
    const early = appIconProblem(file)
    if (early) {
      setProblem(early)
      return
    }
    setBusy(true)
    try {
      const png = await toSquarePng(file)
      const uploaded: any = await filesApi.upload(new File([png], 'app-icon.png', { type: 'image/png' }), agentId)
      if (!uploaded?.id) throw new Error('The icon was not stored.')
      setLocal({ fileId: uploaded.id, url: URL.createObjectURL(png) })
      onChange(uploaded.id)
    } catch (err) {
      setProblem(err instanceof AppIconError ? err.message : getApiErrorMessage(err, 'The icon could not be uploaded.'))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="space-y-2" data-testid="app-icon-field">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted">
          {preview ? (
            <img src={preview} alt="App icon" className="h-full w-full object-contain" />
          ) : (
            <ImageIcon className="h-6 w-6 text-muted-foreground" aria-label="No app icon" />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            id={id}
            type="file"
            accept={APP_ICON_TYPES.join(',')}
            className="sr-only"
            aria-label="App icon file"
            onChange={(e) => void choose(e.target.files?.[0])}
          />
          <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
            {value ? 'Replace icon' : 'Upload icon'}
          </Button>
          {value && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setProblem(null); onChange(null) }}>
              Remove
            </Button>
          )}
        </div>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        A PNG, JPG or WebP, at least {APP_ICON_SIDE} pixels on each side and under 4 MB. The desktop app wears it; the terminal app has no icon.
      </p>
    </div>
  )
}
