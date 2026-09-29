/**
 * The one box an API is connected from: paste a link, drop a file, or
 * paste the description itself. What it is (OpenAPI, Swagger, GraphQL,
 * WSDL, proto) is worked out on the server from the content, so the box
 * asks nothing else.
 */
import { useRef, useState, type DragEvent } from 'react'
import { FileText, Upload, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export const SOURCE_BOX_LABEL = 'Paste a link, drop a file, or paste it here'

/** A single http(s) link on its own, as opposed to pasted text. */
export function isLink(text: string): boolean {
  const value = text.trim()
  if (!value || /\s/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** What the box holds, in the shape the import calls take. Null when empty. */
export function readSource(text: string, file: File | null): { url?: string; content?: string; file?: File } | null {
  if (file) return { file }
  if (!text.trim()) return null
  return isLink(text) ? { url: text.trim() } : { content: text }
}

interface SourceBoxProps {
  id: string
  text: string
  file: File | null
  onTextChange: (text: string) => void
  onFileChange: (file: File | null) => void
  error?: string | null
  disabled?: boolean
}

export function SourceBox({ id, text, file, onTextChange, onFileChange, error, disabled }: SourceBoxProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) onFileChange(dropped)
    else {
      const dropped = e.dataTransfer.getData('text')
      if (dropped) onTextChange(dropped)
    }
  }

  return (
    <div
      className="space-y-2"
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-testid="source-box"
    >
      <Label htmlFor={id}>{SOURCE_BOX_LABEL}</Label>
      {file ? (
        <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm" data-testid="source-file">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{file.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto h-6 w-6"
            onClick={() => onFileChange(null)}
            aria-label={`Remove ${file.name}`}
            disabled={disabled}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ) : (
        <Textarea
          id={id}
          rows={6}
          className={cn('font-mono text-xs', dragging && 'border-primary ring-1 ring-primary/30')}
          placeholder="https://api.example.com/openapi.json"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
          disabled={disabled}
        />
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={disabled}>
          <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Choose a file
        </Button>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          aria-label="Choose a file"
          accept=".json,.yaml,.yml,.graphql,.gql,.wsdl,.xml,.proto,.txt"
          onChange={(e) => {
            const chosen = e.target.files?.[0] ?? null
            if (chosen) onFileChange(chosen)
            e.target.value = ''
          }}
        />
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          OpenAPI or Swagger, GraphQL, WSDL or .proto. A GraphQL endpoint&rsquo;s own link works too.
        </span>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive" data-testid="source-error">
          {error}
        </p>
      )}
    </div>
  )
}
