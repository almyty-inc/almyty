import React from 'react'
import { Eye, EyeOff } from 'lucide-react'

import { Input, type InputProps } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * The pieces every sign-in and sign-up form shares, so the auth pages read
 * as one set: the page title with its one-line lead, a labelled field with
 * its hint and error under it, and a password input with a show/hide
 * control that has a name.
 */

export function AuthHeading({ title, lead }: { title: string; lead?: React.ReactNode }) {
  return (
    <div className="mb-8 space-y-2">
      <h1 className="font-heading text-[28px] font-bold leading-9 tracking-[-0.03em] text-foreground">{title}</h1>
      {lead && <p className="text-sm text-muted-foreground">{lead}</p>}
    </div>
  )
}

interface AuthFieldProps {
  id: string
  label: string
  /** Shown under the field before anything is typed. */
  hint?: React.ReactNode
  error?: string
  children: React.ReactElement
  className?: string
}

/**
 * A label, its control, then the hint and the error. The control is told
 * which of those describe it and whether it is invalid, so a screen reader
 * hears the error with the field.
 */
export function AuthField({ id, label, hint, error, children, className }: AuthFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {React.cloneElement(children, {
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
      } as Record<string, unknown>)}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * A password input with a show/hide control inside it. The control is named
 * for what it does to the typed text, so a field labelled "Password" stays
 * the only thing on the page with that name.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<InputProps, 'type'>>(
  ({ className, ...props }, ref) => {
    const [shown, setShown] = React.useState(false)
    return (
      <div className="relative">
        <Input ref={ref} type={shown ? 'text' : 'password'} className={cn('pr-11', className)} {...props} />
        <button
          type="button"
          aria-label={shown ? 'Hide what you typed' : 'Show what you typed'}
          aria-pressed={shown}
          aria-controls={props.id}
          onClick={() => setShown((v) => !v)}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
    )
  },
)
PasswordInput.displayName = 'PasswordInput'

/** A failure from the server, said once, next to the button that caused it. */
export function AuthAlert({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" aria-live="polite" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
      <p className="text-sm text-destructive">{children}</p>
    </div>
  )
}
