import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * Share tools is built from the pieces the rest of the product already
 * uses, and there is one way to make a gateway for tools.
 *
 * The page answers one question (what to share); the rest is the shared
 * "Who can use it" line and the shared Advanced fold. The client snippets
 * are built in one place, lib/gateway-connect.ts, so the gateway page and
 * the guide can't drift into two different commands. And the old create
 * form, which asked for a protocol and offered an agent, is gone: an agent
 * is put in front of people from its app. These read the source.
 */
const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'test') continue
      out.push(...sources(path))
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      out.push(path)
    }
  }
  return out
}
const all = sources(SRC).map((path) => ({ rel: relative(SRC, path), text: readFileSync(path, 'utf8') }))

describe('share tools reuses the shared pieces', () => {
  const form = read('components/gateways/share-tools-form.tsx')

  it('imports the shared form page, "Who can use it" line and Advanced fold', () => {
    expect(form).toMatch(/from '@\/components\/layout\/form-page'/)
    expect(form).toMatch(/import \{ WhoCanUse \} from '@\/components\/llm-providers\/who-can-use'/)
    expect(form).toMatch(/import \{ Disclosure \} from '@\/components\/ui\/disclosure'/)
  })

  it('has one Advanced fold in the codebase, not a copy per page', () => {
    const own = all.filter(({ text }) => /function Disclosure\s*\(/.test(text)).map(({ rel }) => rel)
    expect(own).toEqual(['components/ui/disclosure.tsx'])
    expect(read('pages/provider.tsx')).toMatch(/import \{ Disclosure \} from '@\/components\/ui\/disclosure'/)
  })

  it('builds every client snippet in lib/gateway-connect.ts', () => {
    const builders = all
      .filter(({ text }) => /claude mcp add|mcp-remote|mcpServers/.test(text))
      .map(({ rel }) => rel)
      // The per-protocol Integrations tab and the tool page's "where it is
      // served" list still render their own configs for single-protocol
      // gateways; nothing new may join them.
      .filter((rel) => !['components/gateways/detail/integrations-section.tsx', 'pages/tool-detail.tsx'].includes(rel))
    expect(builders).toEqual(['lib/gateway-connect.ts'])
    expect(read('components/gateways/connect-snippets.tsx')).toMatch(/sharedToolsSnippets/)
  })

  it('shows the snippets and the switch on the gateway page', () => {
    const page = read('pages/gateway-detail.tsx')
    expect(page).toMatch(/import \{ ConnectSnippets \} from '@\/components\/gateways\/connect-snippets'/)
    expect(page).toMatch(/<GatewayStatusSwitch\b/)
  })
})

describe('there is one way to make a gateway for tools', () => {
  it('/gateways/new is Share tools', () => {
    expect(read('pages/gateway-new.tsx')).toMatch(/<ShareToolsForm \/>/)
  })

  it('no longer offers an agent, a channel or a protocol choice', () => {
    expect(existsSync(join(SRC, 'components/gateways/create-gateway-form.tsx'))).toBe(false)
    const offenders = all.filter(({ text }) => /AGENT_GATEWAY_TYPES|TOOL_GATEWAY_TYPES/.test(text)).map(({ rel }) => rel)
    expect(offenders).toEqual([])
    const form = read('components/gateways/share-tools-form.tsx')
    expect(form).not.toMatch(/agentId|'a2a'|'slack'|Protocol/)
  })

  it('never sets a status by hand beyond pause and resume', () => {
    const edit = read('components/gateways/detail/gateway-edit-form.tsx')
    expect(edit).not.toMatch(/maintenance|'error'/)
  })
})
