import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * Nothing exported is left unreferenced.
 *
 * A redesign that deletes the screen using a helper leaves the helper
 * behind: it compiles, its own test stays green, and nothing reaches it.
 * The Apps change left most of a channel-setup module like that, and the
 * surface catalog client call outlived the canvas that made it. These read
 * the source, because a test that imports the unit is exactly the
 * reference that hides it.
 *
 * Each list below holds what was already unreferenced when this guard
 * arrived. It only shrinks: an entry that gains a caller, or is deleted,
 * has to leave the list.
 */
const SRC = join(__dirname, '..')

function productionFiles(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && name !== 'test') productionFiles(path, out)
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

const sources = new Map(productionFiles().map((file) => [relative(SRC, file), readFileSync(file, 'utf8')]))
const escape = (s: string) => s.replace(/[$]/g, '\\$')

/** Exported functions, constants and classes that no production file uses, their own included. */
function unreferencedExports(): string[] {
  const out: string[] = []
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1]
      const word = new RegExp(`\\b${escape(name)}\\b`, 'g')
      if ((src.match(word) ?? []).length > 1) continue
      const elsewhere = [...sources].some(([other, osrc]) => other !== file && new RegExp(`\\b${escape(name)}\\b`).test(osrc))
      if (!elsewhere) out.push(`${file}:${name}`)
    }
  }
  return out.sort()
}

/** The methods of each API client object (`export const xApi = { ... }`) in lib/. */
function clientMethods(): Map<string, string[]> {
  const clients = new Map<string, string[]>()
  for (const [file, src] of sources) {
    if (!file.startsWith('lib/')) continue
    for (const m of src.matchAll(/^export const (\w+Api) = \{\n([\s\S]*?)^\}/gm)) {
      clients.set(m[1], [...m[2].matchAll(/^ {2}(\w+)\s*[:(]/gm)].map((k) => k[1]))
    }
  }
  return clients
}

/** Client methods no production file calls, a call chain broken across lines included. */
function uncalledClientMethods(clients: Map<string, string[]>): string[] {
  const out: string[] = []
  for (const [client, methods] of clients) {
    for (const method of methods) {
      const call = new RegExp(`\\b${client}\\s*\\.\\s*${method}\\b`)
      if (![...sources.values()].some((s) => call.test(s))) out.push(`${client}.${method}`)
    }
  }
  return out.sort()
}

const KNOWN_UNREFERENCED_EXPORTS = [
  'components/connections/health-badge.tsx:healthLabel',
  'components/llm-providers/credential-slot.tsx:MASKED_KEY',
  'components/llm-providers/schema.ts:MASKED_PROVIDER_KEY',
  'components/model-picker.tsx:keyRejected',
  'components/models/hosting/host-body.ts:adapterHasSecrets',
  'components/plan-indicator.tsx:planFromEntitlements',
  'lib/connections-api.ts:groupConnectorsByKind',
  'lib/connections-api.ts:isOAuthMethod',
  'lib/deployments-api.ts:describeModelRef',
  'lib/deployments-api.ts:runnableAdapters',
  'lib/return-to.ts:currentReturnPath',
  'lib/sentry.ts:isSentryEnabled',
  'lib/utils.ts:formatCurrency',
  'store/organization.ts:getCurrentOrganizationId',
  'types/connections.ts:CONNECTION_OWNER_HINTS',
  'types/connections.ts:CONNECTION_OWNER_LABELS',
].sort()

/** Every client object in lib/, found in the source rather than listed by hand. */
const CLIENTS = clientMethods()
const KNOWN_UNCALLED_METHODS: string[] = []

describe('no export is left unreferenced', () => {
  it('every exported function, constant and class has a production use', () => {
    expect(unreferencedExports()).toEqual(KNOWN_UNREFERENCED_EXPORTS)
  })

  it('finds every client object in lib/ and the methods of each', () => {
    const declared = [...sources]
      .filter(([file]) => file.startsWith('lib/'))
      .flatMap(([, src]) => [...src.matchAll(/^export const (\w+Api)\s*=/gm)].map((m) => m[1]))
    expect([...CLIENTS.keys()].sort()).toEqual(declared.sort())
    for (const [client, methods] of CLIENTS) expect(methods.length, client).toBeGreaterThan(0)
  })

  it('every client method has a production caller', () => {
    expect(uncalledClientMethods(CLIENTS)).toEqual(KNOWN_UNCALLED_METHODS)
  })
})
