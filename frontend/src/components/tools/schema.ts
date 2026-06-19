import { z } from 'zod'

export const createToolSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or fewer'),
  description: z.string().max(1000, 'Description must be 1000 characters or fewer').optional(),
})

export type CreateToolForm = z.infer<typeof createToolSchema>
