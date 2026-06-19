import { z } from 'zod'

// Mirrors backend/src/modules/credentials/dto/credentials.dto.ts:
//   name @MaxLength(200), description @MaxLength(2000), type @MaxLength(50).
export const createCredentialSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name must be 200 characters or fewer'),
  type: z.string().min(1, 'Type is required').max(50, 'Type must be 50 characters or fewer'),
  description: z.string().max(2000, 'Description must be 2000 characters or fewer').optional(),
  value: z.string().min(1, 'Value is required'),
})

export type CreateCredentialForm = z.infer<typeof createCredentialSchema>
