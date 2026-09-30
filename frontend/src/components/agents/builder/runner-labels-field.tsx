import React, { useEffect, useState } from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Which machine an agent's runner tools run on: label requirements typed
 * as `gpu=yes, os=mac`. The server routes each runner tool call to an
 * online runner carrying every label (and says "No machine with gpu=yes
 * is online" when none does), and stores what was typed as an object,
 * which comes back here as the same text.
 */
export function formatRunnerLabels(value: Record<string, string> | string | null | undefined): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  return Object.entries(value).map(([k, v]) => `${k}=${v}`).join(', ')
}

/** The labels as an object, from the stored object or the typed text; malformed parts left out. */
export function parseRunnerLabels(value: Record<string, string> | string | null | undefined): Record<string, string> {
  if (!value) return {}
  if (typeof value !== 'string') return { ...value }
  const out: Record<string, string> = {}
  for (const part of value.split(/[,\n]/)) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const key = part.slice(0, at).trim()
    const val = part.slice(at + 1).trim()
    if (key && val) out[key] = val
  }
  return out
}

/** The parts of the typed text that are not key=value, for a hint in place. */
export function malformedRunnerLabels(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter((p) => p && (p.indexOf('=') <= 0 || !p.slice(p.indexOf('=') + 1).trim()))
}

export function RunnerLabelsField({
  id = 'runner-labels',
  value,
  onChange,
  hint,
}: {
  id?: string
  value: Record<string, string> | string | null | undefined
  onChange: (text: string) => void
  hint: React.ReactNode
}) {
  const [text, setText] = useState(() => formatRunnerLabels(value))
  // A save round-trips the text into an object; show it as text again.
  useEffect(() => {
    if (formatRunnerLabels(value) !== text) setText(formatRunnerLabels(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const bad = malformedRunnerLabels(text)
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm">Machine labels</Label>
      <Input
        id={id}
        value={text}
        placeholder="gpu=yes, os=mac"
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        aria-invalid={bad.length > 0 || undefined}
        onChange={(e) => {
          setText(e.target.value)
          onChange(e.target.value)
        }}
      />
      {bad.length > 0 ? (
        <p id={`${id}-hint`} className="text-xs text-destructive">
          Write each label as key=value, for example gpu=yes. Not a label: {bad.join(', ')}
        </p>
      ) : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}
