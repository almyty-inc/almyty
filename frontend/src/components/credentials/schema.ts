import { z } from 'zod'

// Mirrors backend/src/modules/credentials/dto/credentials.dto.ts:
//   name @MaxLength(200), description @MaxLength(2000), type @MaxLength(50).
/**
 * `value` is only the right question for a single-secret type.
 *
 * basic_auth needs a username and a password, oauth2 a client id and
 * secret, and custom neither -- but this required `value` for all of
 * them, and the form rendered no `value` input for those types. Picking
 * "Basic Auth" therefore always failed with "Value is required",
 * pointing at a field that was not on screen. Three of the six offered
 * types could not be created at all.
 */
export const createCredentialSchema = z
  .object({
    name: z.string().min(1, 'Name is required').max(200, 'Name must be 200 characters or fewer'),
    type: z.string().min(1, 'Type is required').max(50, 'Type must be 50 characters or fewer'),
    description: z.string().max(2000, 'Description must be 2000 characters or fewer').optional(),
    value: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
  })
  .superRefine((form, ctx) => {
    const require = (field: string, message: string) => {
      if (!(form as any)[field]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message })
      }
    }
    if (['api_key', 'bearer_token', 'jwt'].includes(form.type)) {
      require('value', 'Value is required')
    } else if (form.type === 'basic_auth') {
      require('username', 'Username is required')
      require('password', 'Password is required')
    } else if (form.type === 'oauth2') {
      require('clientId', 'Client ID is required')
      require('clientSecret', 'Client Secret is required')
    }
  })

/** The `config` blob the backend stores, built from whichever fields the type uses. */
export function credentialConfig(form: {
  type: string
  value?: string
  username?: string
  password?: string
  clientId?: string
  clientSecret?: string
}): Record<string, string> {
  if (form.type === 'basic_auth') {
    return { username: form.username ?? '', password: form.password ?? '' }
  }
  if (form.type === 'oauth2') {
    return { clientId: form.clientId ?? '', clientSecret: form.clientSecret ?? '' }
  }
  return form.value ? { value: form.value } : {}
}

export type CreateCredentialForm = z.infer<typeof createCredentialSchema>
