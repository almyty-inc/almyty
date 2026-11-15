/* Form -- the one <form> the app renders.
 *
 * A form section can end up inside another form: an inline "New key" inside
 * a channel page (a FormPage <form>), a connect flow inside an add-credential
 * page. A <form> inside a <form> is invalid HTML; its submit button and the
 * Enter key then also submit the outer form (React's submit event bubbles to
 * the outer handler, and a submit button outside its own form submits the
 * page), so the inner action never happens.
 *
 * Form renders a real <form> when nothing around it is one. Inside another
 * Form it renders a role="form" group instead and does the submit itself:
 * a click on one of its own submit buttons, or Enter in one of its text
 * fields, runs its onSubmit and goes no further. Use it for every form;
 * the guard test (src/__tests__/no-nested-forms.test.tsx) refuses a raw <form> anywhere else.
 */
import {
  createContext,
  forwardRef,
  useContext,
  useRef,
  type FormEvent,
  type FormHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
} from 'react'

const InsideForm = createContext(false)

export interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  onSubmit?: (event: FormEvent<HTMLFormElement>) => unknown
  /** Render as a group even with no Form around it (an outer raw <form> the context cannot see). */
  nested?: boolean
}

/** Input types where Enter submits the form they belong to. */
const NON_SUBMITTING_INPUTS = new Set(['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit', 'color', 'range'])

export const Form = forwardRef<HTMLFormElement, FormProps>(function Form(
  { onSubmit, nested = false, children, noValidate, ...rest },
  ref,
) {
  const inside = useContext(InsideForm)
  const boxRef = useRef<HTMLDivElement>(null)

  if (!inside && !nested) {
    return (
      <InsideForm.Provider value={true}>
        <form ref={ref} noValidate={noValidate} onSubmit={onSubmit} {...rest}>
          {children}
        </form>
      </InsideForm.Provider>
    )
  }

  const ownedByThisBox = (el: Element) => el.closest('[data-nested-form]') === boxRef.current

  const submit = (event: SyntheticEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const box = boxRef.current
    if (!noValidate && box) {
      const fields = Array.from(box.querySelectorAll<HTMLInputElement>('input, select, textarea')).filter(ownedByThisBox)
      const invalid = fields.find(field => typeof field.checkValidity === 'function' && !field.checkValidity())
      if (invalid) {
        invalid.reportValidity?.()
        return
      }
    }
    void onSubmit?.(event as unknown as FormEvent<HTMLFormElement>)
  }

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    const button = (event.target as Element).closest?.('button, input[type="submit"]') as HTMLButtonElement | HTMLInputElement | null
    if (!button || button.type !== 'submit' || button.disabled || !ownedByThisBox(button)) return
    submit(event)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing) return
    const target = event.target as HTMLElement
    if (target.tagName !== 'INPUT' || NON_SUBMITTING_INPUTS.has((target as HTMLInputElement).type)) return
    if (!ownedByThisBox(target)) return
    submit(event)
  }

  const { className, id, title, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, 'aria-describedby': ariaDescribedBy } = rest
  const dataAttributes = Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith('data-')))
  return (
    <div
      ref={boxRef}
      role="form"
      data-nested-form=""
      className={className}
      id={id}
      title={title}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      {...dataAttributes}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
})
