/**
 * apis/schema -- zod schema + form types for the Edit API page.
 *
 * Used by `components/apis/api-form.tsx`. Connecting an API has no form
 * to validate: it is one box, read on the server.
 */
import { z } from 'zod'

export const editApiSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100, 'Name must be 100 characters or fewer'),
  description: z.string().max(1000, 'Description must be 1000 characters or fewer').optional(),
  // `.default('')` rather than `.optional()`: the field and the submit
  // handler both want a plain string (see @hookform/resolvers v5 typing).
  baseUrl: z.string().trim().default(''),
  version: z.string().optional(),
}).refine((data) => {
  // Empty is allowed (an SDK API, or a .proto that named none yet); anything
  // typed must be an http(s) address.
  if (!data.baseUrl) return true
  return /^https?:\/\/.+/i.test(data.baseUrl)
}, {
  message: 'Enter an address starting with http:// or https://',
  path: ['baseUrl'],
})

// `Input` is what the form binds to (defaults not yet applied); `Output`
// is what the submit handler receives. useForm<Input, Context, Output>.
export type EditApiFormInput = z.input<typeof editApiSchema>
export type EditApiFormData = z.output<typeof editApiSchema>
