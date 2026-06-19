import { z } from 'zod'

export const createGatewaySchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or fewer'),
  type: z.string().min(1, 'Type is required'),
  endpoint: z.string()
    .min(1, 'Endpoint path is required')
    .max(200, 'Endpoint path must be 200 characters or fewer')
    .regex(/^\/[a-zA-Z0-9-_/]*$/, 'Must start with / and contain only alphanumeric, -, _, /'),
  description: z.string().max(1000, 'Description must be 1000 characters or fewer').optional(),
})

export type CreateGatewayForm = z.infer<typeof createGatewaySchema>
