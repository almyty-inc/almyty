import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  claudeCodeCommand,
  connectCommandFor,
  mcpEndpointFor,
  orgSlugOf,
  skillsInstallCommand,
} from '../gateway-connect'

const gw = { name: 'Weather API', type: 'mcp', endpoint: '/weather-api' }

describe('gateway connect commands', () => {
  it('builds the MCP address from the org slug and the gateway endpoint', () => {
    expect(mcpEndpointFor(gw, 'acme', 'https://api.example')).toBe('https://api.example/acme/weather-api')
  })

  it('gives Claude Code one command, named after the gateway', () => {
    expect(claudeCodeCommand(gw, 'acme', 'https://api.example')).toBe(
      'claude mcp add weather-api --transport http https://api.example/acme/weather-api',
    )
  })

  it('picks the command by protocol, and none where there is no one-liner', () => {
    expect(connectCommandFor(gw, 'acme', 'https://x')).toMatch(/^claude mcp add /)
    expect(connectCommandFor({ ...gw, type: 'skills' }, 'acme')).toBe(skillsInstallCommand(gw, 'acme'))
    expect(skillsInstallCommand(gw, 'acme')).toBe('npx @almyty/skills install @acme/weather-api')
    expect(connectCommandFor({ ...gw, type: 'a2a' }, 'acme')).toBeNull()
  })

  it('derives the org slug the way the gateway page does', () => {
    expect(orgSlugOf({ slug: 'acme' })).toBe('acme')
    expect(orgSlugOf({ name: 'Acme Corp' })).toBe('acme-corp')
    expect(orgSlugOf(null)).toBe('org')
  })

  it('is the one source for the Integrations tab too', () => {
    // Two copies of this string are how the guide and the gateway page
    // would come to show different commands for the same gateway.
    const src = readFileSync(
      join(__dirname, '..', '..', 'components', 'gateways', 'detail', 'integrations-section.tsx'),
      'utf8',
    )
    expect(src).toContain("from '@/lib/gateway-connect'")
    expect(src).not.toMatch(/`claude mcp add \$\{/)
  })
})
