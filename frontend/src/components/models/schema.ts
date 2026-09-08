import { z } from 'zod'

import { MODEL_PRIVACY_TIERS, type ModelCapabilities, type ModelPricing } from '@/types/models'

/**
 * Form schemas for the catalog dialogs. Numbers arrive as strings from the
 * inputs; the schemas coerce them and treat an empty field as "not set".
 */

const optionalPositiveInt = z
  .union([z.literal(''), z.coerce.number().int().min(1, 'Must be at least 1')])
  .optional()
  .transform((v) => (v === '' || v === undefined ? undefined : v))

const optionalPrice = z
  .union([z.literal(''), z.coerce.number().min(0, 'Must be zero or more')])
  .optional()
  .transform((v) => (v === '' || v === undefined ? undefined : v))

export const capabilitiesSchema = z.object({
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  embedding: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
})

export const privacyTierSchema = z.enum(MODEL_PRIVACY_TIERS as [string, ...string[]])

export const registerEndpointSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  url: z.string().trim().url('Enter the base URL including the protocol'),
  apiKey: z.string().optional(),
  connectionId: z.string().optional(),
  vendorModelId: z.string().trim().min(1, 'Model id is required').max(255),
  privacyTier: privacyTierSchema,
  region: z.string().trim().max(64).optional(),
  contextLength: optionalPositiveInt,
  capabilities: capabilitiesSchema.optional(),
})

export type RegisterEndpointFormData = z.input<typeof registerEndpointSchema>
export type RegisterEndpointFormOutput = z.output<typeof registerEndpointSchema>

export const registerModelSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  providerId: z.string().min(1, 'Pick a provider'),
  vendorModelId: z.string().trim().min(1, 'Model id is required').max(255),
  privacyTier: privacyTierSchema,
  region: z.string().trim().max(64).optional(),
  contextLength: optionalPositiveInt,
  capabilities: capabilitiesSchema.optional(),
})

export type RegisterModelFormData = z.input<typeof registerModelSchema>
export type RegisterModelFormOutput = z.output<typeof registerModelSchema>

export const editModelSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  privacyTier: privacyTierSchema,
  region: z.string().trim().max(64).optional(),
  contextLength: optionalPositiveInt,
  capabilities: capabilitiesSchema,
  /** Off means "use the feed price": the override is cleared on save. */
  overridePrice: z.boolean(),
  inPerMTok: optionalPrice,
  outPerMTok: optionalPrice,
}).superRefine((data, ctx) => {
  if (data.overridePrice) {
    if (data.inPerMTok === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inPerMTok'], message: 'Input price is required' })
    if (data.outPerMTok === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outPerMTok'], message: 'Output price is required' })
  }
})

export type EditModelFormData = z.input<typeof editModelSchema>
export type EditModelFormOutput = z.output<typeof editModelSchema>

/** Drops capability keys that are false so the card stores only what is on. */
export function compactCapabilities(caps: ModelCapabilities | undefined): ModelCapabilities | undefined {
  if (!caps) return undefined
  const out: ModelCapabilities = {}
  for (const [key, value] of Object.entries(caps)) {
    if (value) (out as Record<string, boolean>)[key] = true
  }
  return Object.keys(out).length ? out : undefined
}

export function pricingFromForm(data: Pick<EditModelFormOutput, 'overridePrice' | 'inPerMTok' | 'outPerMTok'>): ModelPricing | null {
  if (!data.overridePrice || data.inPerMTok === undefined || data.outPerMTok === undefined) return null
  return { inPerMTok: data.inPerMTok, outPerMTok: data.outPerMTok, currency: 'USD' }
}
