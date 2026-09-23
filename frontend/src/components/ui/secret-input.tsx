/* SecretInput -- an input for a token, key or secret that a password
 * manager must leave alone.
 *
 * 1Password filled the user's own dashboard login into the WhatsApp
 * access-token field: to a password manager, a lone masked input on a
 * page is a login form. These attributes opt the field out of that for
 * the managers that honour them (1Password, LastPass, Bitwarden, Dashlane)
 * and for the browser's own autofill.
 *
 * `masked` (default true) keeps the value hidden as it is typed. Set it to
 * false for identifiers that are not secret but still must not autofill
 * (a phone-number id, a verify token the user chose).
 */
import * as React from 'react'

import { Input, type InputProps } from '@/components/ui/input'

export const SECRET_INPUT_ATTRS = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const

export interface SecretInputProps extends Omit<InputProps, 'type'> {
  masked?: boolean
}

export const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ masked = true, className, ...props }, ref) => (
    <Input
      ref={ref}
      type={masked ? 'password' : 'text'}
      className={className}
      {...SECRET_INPUT_ATTRS}
      {...props}
    />
  ),
)
SecretInput.displayName = 'SecretInput'
