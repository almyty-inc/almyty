/**
 * apis/schema — zod schemas + form types for the Connect/Edit API flow.
 *
 * Used by `components/apis/create-api-dialog.tsx`. Kept in its own file so
 * the long comment about the three-generic `useForm<Input, any, Output>`
 * pattern lives next to the types it explains.
 */
import { z } from 'zod'
import { ApiAuthType, ApiType } from '@/types'

export const createApiSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional(),
  type: z.nativeEnum(ApiType),
  // NOT .optional() — `.default('')` already makes the input
  // optional but produces a `string` output, which is what the
  // form field and submit handler expect. Chaining `.optional()`
  // on top confuses the `@hookform/resolvers/zod` v5 type inference
  // into thinking the output is `string | undefined`, which then
  // doesn't match `useForm<CreateApiFormData>` (where baseUrl is
  // a plain `string`).
  baseUrl: z.string().default(''),
  version: z.string().optional(),
  configuration: z.record(z.any()).optional(),
  authentication: z.object({
    type: z.nativeEnum(ApiAuthType),
    config: z.record(z.any()),
  }).optional(),
}).refine((data) => {
  // SDK type doesn't require a baseUrl
  if (data.type === ApiType.SDK) return true
  // All other types require a valid URL
  try {
    if (!data.baseUrl) return false
    new URL(data.baseUrl)
    return true
  } catch {
    return false
  }
}, {
  message: 'Please enter a valid URL',
  path: ['baseUrl'],
})

export const importSchemaSchema = z.object({
  schemaContent: z.string().optional(),
  schemaUrl: z.string().url().optional(),
  description: z.string().optional(),
  generateTools: z.boolean().optional(),
}).refine((data) => data.schemaContent || data.schemaUrl, {
  message: 'Either schema content or URL must be provided',
  path: ['schemaContent'],
})

// Two separate types: `Input` is the shape the form BINDS to
// (with optional defaults still unfilled); `Output` is the shape
// the submit handler RECEIVES after zod has applied defaults +
// refinements. `@hookform/resolvers/zod` v5 requires both to be
// passed to `useForm<Input, Context, Output>` so the resolver's
// generics line up — otherwise it complains that the inferred
// input shape (with `baseUrl?: string`) doesn't match a form
// whose submit handler wants `baseUrl: string`.
export type CreateApiFormInput = z.input<typeof createApiSchema>
export type CreateApiFormData = z.output<typeof createApiSchema>
export type ImportSchemaFormData = z.output<typeof importSchemaSchema>
