// The fake upstreams by name. Each loads only when started, since some
// build their state when imported (an in-memory database, a key pair).
import type { Service } from '../server.ts'

export const SERVICES: Record<string, () => Promise<Service>> = {
  northwind: async () => (await import('./northwind.ts')).northwind,
  parcelwise: async () => (await import('./parcelwise.ts')).parcelwise,
}
