/**
 * Where a description comes from, for the kind picked on "Connect an API":
 * a link, a file or the text itself, only the ways that kind comes in.
 */
import { useRef } from 'react'
import { FileText, Upload, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { MODE_LABELS, type DescriptionKind, type SourceMode } from './api-types'

export interface ApiSourceValue {
  mode: SourceMode
  link: string
  file: File | null
  text: string
}

/** What the field holds, in the shape POST /apis/import takes. Null when empty. */
export function sourceOf(value: ApiSourceValue): { url?: string; content?: string; file?: File } | null {
  if (value.mode === 'file') return value.file ? { file: value.file } : null
  if (value.mode === 'link') return value.link.trim() ? { url: value.link.trim() } : null
  return value.text.trim() ? { content: value.text } : null
}

/** Why the field cannot be sent yet, in words; null when it can. */
export function sourceError(value: ApiSourceValue): string | null {
  if (value.mode === 'link') {
    if (!value.link.trim()) return 'Paste the link.'
    if (!/^https?:\/\/\S+$/i.test(value.link.trim())) return 'A link starts with http:// or https://.'
    return null
  }
  if (value.mode === 'file') return value.file ? null : 'Choose a file.'
  return value.text.trim() ? null : 'Paste the description.'
}

export function ApiSourceField({
  id,
  kind,
  value,
  onChange,
  error,
  disabled,
}: {
  id: string
  kind: DescriptionKind
  value: ApiSourceValue
  onChange: (next: ApiSourceValue) => void
  error?: string | null
  disabled?: boolean
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const errorId = error ? `${id}-error` : undefined
  const set = (patch: Partial<ApiSourceValue>) => onChange({ ...value, ...patch })

  return (
    <div className="space-y-3" data-testid="api-source">
      {kind.modes.length > 1 && (
        <Tabs value={value.mode} onValueChange={(mode) => set({ mode: mode as SourceMode })}>
          <TabsList aria-label="Give it as">
            {kind.modes.map((mode) => (
              <TabsTrigger key={mode} value={mode} disabled={disabled}>
                {MODE_LABELS[mode]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {value.mode === 'link' && (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{kind.linkLabel}</Label>
          <Input
            id={id}
            type="url"
            value={value.link}
            placeholder={kind.linkPlaceholder}
            onChange={(e) => set({ link: e.target.value })}
            aria-invalid={error ? true : undefined}
            aria-describedby={errorId}
            disabled={disabled}
            autoComplete="off"
          />
          {kind.linkHint && <p className="text-xs text-muted-foreground">{kind.linkHint}</p>}
        </div>
      )}

      {value.mode === 'file' && (
        <div className="space-y-1.5">
          <Label htmlFor={id}>File</Label>
          {value.file ? (
            <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm" data-testid="source-file">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate font-medium">{value.file.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{(value.file.size / 1024).toFixed(1)} KB</span>
              <Button type="button" variant="ghost" size="icon" className="ml-auto h-6 w-6" onClick={() => set({ file: null })} aria-label={`Remove ${value.file.name}`} disabled={disabled}>
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ) : (
            <div>
              <Button id={id} type="button" variant="outline" onClick={() => fileInput.current?.click()} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={errorId}>
                <Upload className="mr-2 h-4 w-4" aria-hidden />
                Choose a file
              </Button>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            aria-label="Choose a file"
            accept={kind.fileAccept}
            onChange={(e) => {
              const chosen = e.target.files?.[0] ?? null
              if (chosen) set({ file: chosen })
              e.target.value = ''
            }}
          />
        </div>
      )}

      {value.mode === 'paste' && (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{kind.pasteLabel}</Label>
          <Textarea
            id={id}
            rows={10}
            className="font-mono text-xs"
            value={value.text}
            placeholder={kind.pastePlaceholder}
            onChange={(e) => set({ text: e.target.value })}
            aria-invalid={error ? true : undefined}
            aria-describedby={errorId}
            disabled={disabled}
          />
        </div>
      )}

      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive" data-testid="source-error">
          {error}
        </p>
      )}
    </div>
  )
}
