// Stack profiles: which fake upstreams a set of walks needs, on which
// ports, and what the API is started with. The ports are the ones the
// published screenshots show (an API's address under Advanced), so a
// profile keeps them. stack.sh reads `npm run demo -- profile <name>`.
import { HERE } from '../engine/env.ts'

export interface Profile {
  description: string
  /** Fake upstreams to start: service names on a port, with extra environment. */
  fakes: { services: string[]; port: number; env?: Record<string, string> }[]
  /** The API's email, Slack and Telegram calls go to this fake port instead of the real services. */
  redirect?: number
  /** More modules the API loads with node --import (paths under scripts/demo-seed). */
  preload?: string[]
  /** Started with PUBLIC_API_URL set to the API's own address (a Telegram channel registers its webhook only then). */
  publicApi?: boolean
}

// The Northwind fake (model vendors and company APIs) runs in every profile, on FAKE_PORT.
export const PROFILES: Record<string, Profile> = {
  northwind: { description: 'Northwind AI: the seeded organization and the use-case guides', fakes: [] },
  velora: {
    description: 'Velora Energy: the governance example guides (Stripe, Splunk, Entra ID, DNS and a scripted model)',
    fakes: [{ services: ['velora'], port: 4291 }],
    redirect: 4291,
    preload: ['fakes/preload/velora.ts'],
  },
}

// A second stack beside the canonical one (a walk under development) moves
// every fake port by DEMO_PORT_OFFSET. Its screenshots then show other
// ports, so only a stack without an offset is captured for publishing.
const offset = () => Number(process.env.DEMO_PORT_OFFSET || 0)

/** Lines stack.sh evaluates: FAKE <services> <port> [K=V...], REDIRECT <port>, PRELOAD <file>, PUBLIC_API 1. */
export function profileLines(name: string): string[] {
  const p = PROFILES[name]
  return [
    ...p.fakes.map((f) => ['FAKE', f.services.join(','), String(f.port + offset()), ...Object.entries(f.env ?? {}).map(([k, v]) => `${k}=${v}`)].join(' ')),
    ...(p.redirect ? [`REDIRECT ${p.redirect + offset()}`] : []),
    ...(p.preload ?? []).map((f) => `PRELOAD ${HERE}/${f}`),
    ...(p.publicApi ? ['PUBLIC_API 1'] : []),
  ]
}
