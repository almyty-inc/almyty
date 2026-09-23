/* FormPage -- the one shape every create and configure flow takes.
 *
 * The product rule is "no dialogs": a flow that creates or configures
 * something is a page with its own URL (linkable, the back button works,
 * a refresh keeps you there) or an inline section of the detail view it
 * belongs to. Dialogs clipped their own primary button off the bottom of
 * small screens, nested a second scroll region inside the page, and lost
 * everything on an accidental click outside.
 *
 * This page shape fixes those once:
 *   - one scroll context: the dashboard's <main>. Nothing in here scrolls
 *     on its own.
 *   - one sticky footer with Cancel and ONE primary action, always in view.
 *   - Cancel and the back link ask before discarding a dirty form
 *     (pass `guard` from useLeaveGuard).
 *   - a failed submit scrolls the first invalid field into view and
 *     focuses it (anything marked aria-invalid, or a <Field error>).
 *
 * `onSubmit` is optional: a page that only shows something (a generated
 * key, a read-only view) renders no <form> and no footer.
 */
import {
  Children,
  cloneElement,
  isValidElement,
  useRef,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'

import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { LeaveGuard } from '@/hooks/use-leave-guard'
import { cn } from '@/lib/utils'

const INVALID_SELECTOR = [
  '[aria-invalid="true"]',
  '[data-invalid="true"] input',
  '[data-invalid="true"] textarea',
  '[data-invalid="true"] select',
  '[data-invalid="true"] button',
].join(', ')

/**
 * Scroll the first invalid control under `root` into view and focus it.
 * Returns the element, or null when the form is valid.
 */
export function focusFirstInvalid(root: ParentNode | null): HTMLElement | null {
  if (!root) return null
  const el = root.querySelector<HTMLElement>(INVALID_SELECTOR)
  if (!el) return null
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  el.focus({ preventScroll: true })
  return el
}

/** The width the flow's content column takes. */
const WIDTHS = {
  narrow: 'max-w-2xl',
  default: 'max-w-3xl',
  wide: 'max-w-5xl',
} as const

export interface FormPageProps {
  title: ReactNode
  description?: ReactNode
  /** Where "back" and Cancel go, and what the back link says. */
  back: { to: string; label: string }
  /** From useLeaveGuard: asks before a dirty form is left. */
  guard?: LeaveGuard
  /** Present = this page is a form with a sticky Save/Cancel footer. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => unknown
  submitLabel?: string
  submitting?: boolean
  submitDisabled?: boolean
  cancelLabel?: string
  /** Left side of the footer: a step counter, a "Back" step button. */
  footerStart?: ReactNode
  /** Header actions (rare on a form page). */
  actions?: ReactNode
  width?: keyof typeof WIDTHS
  className?: string
  children: ReactNode
}

export function FormPage({
  title,
  description,
  back,
  guard,
  onSubmit,
  submitLabel = 'Save',
  submitting = false,
  submitDisabled = false,
  cancelLabel = 'Cancel',
  footerStart,
  actions,
  width = 'default',
  className,
  children,
}: FormPageProps) {
  const formRef = useRef<HTMLFormElement>(null)
  const navigate = useNavigate()

  const goBack = (e: React.MouseEvent) => {
    if (!guard) return
    e.preventDefault()
    guard.navigate(back.to)
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    if (!onSubmit) return
    // react-hook-form's handleSubmit calls preventDefault itself; a plain
    // handler may not, and a native submit would reload the page.
    e.preventDefault()
    try {
      await onSubmit(e)
    } finally {
      // Errors render on the next paint.
      requestAnimationFrame(() => focusFirstInvalid(formRef.current))
    }
  }

  const body = (
    <div className="space-y-6">{children}</div>
  )

  return (
    <div className={cn('mx-auto w-full', WIDTHS[width], className)} data-testid="form-page">
      <Link
        to={back.to}
        onClick={goBack}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {back.label}
      </Link>
      <PageHeader title={title} description={description} actions={actions} className="mb-6" />

      {onSubmit ? (
        <form ref={formRef} noValidate onSubmit={handleSubmit}>
          {body}
          <div
            className="sticky bottom-0 z-10 -mx-4 mt-8 flex flex-wrap items-center gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6"
            data-testid="form-page-footer"
          >
            {footerStart}
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => (guard ? guard.navigate(back.to) : navigate(back.to))}
              >
                {cancelLabel}
              </Button>
              <Button type="submit" disabled={submitting || submitDisabled}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {submitLabel}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        body
      )}
      {guard?.element}
    </div>
  )
}

/**
 * Save/Cancel for an inline edit inside a detail view: the same order and
 * styling as the FormPage footer, so editing in place and editing on a
 * page read the same. Put it at the end of the <form> it submits.
 */
export function InlineFormActions({
  onCancel,
  submitLabel = 'Save',
  cancelLabel = 'Cancel',
  submitting = false,
  submitDisabled = false,
  submitVariant = 'default',
  className,
}: {
  onCancel: () => void
  submitLabel?: string
  cancelLabel?: string
  submitting?: boolean
  submitDisabled?: boolean
  /** 'destructive' when saving ends something (reject, revoke). */
  submitVariant?: 'default' | 'destructive'
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-2 pt-2', className)}>
      <Button type="button" variant="outline" onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button type="submit" variant={submitVariant} disabled={submitting || submitDisabled}>
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
        {submitLabel}
      </Button>
    </div>
  )
}

/** A titled group of fields on a form page or in a detail view. */
export function FormSection({
  title,
  description,
  children,
  className,
  id,
}: {
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section
      id={id}
      className={cn('space-y-4 rounded-xl border bg-card p-4 text-card-foreground sm:p-6', className)}
    >
      {(title || description) && (
        <div className="space-y-1">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      )}
      {children}
    </section>
  )
}

/**
 * A labelled field: label, the control, one line saying where to find the
 * value, and the error. The control gets aria-invalid/aria-describedby
 * wired, so screen readers and focusFirstInvalid both find it.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  children: ReactNode
  className?: string
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  const only = Children.count(children) === 1 && isValidElement(children)
  const control = only
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: (children as ReactElement<{ id?: string }>).props.id ?? id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
      })
    : children
  return (
    <div className={cn('space-y-1.5', className)} data-invalid={error ? 'true' : undefined}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      {control}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
