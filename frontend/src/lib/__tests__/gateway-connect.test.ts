import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  claudeCodeCommand,
  connectCommandFor,
  gatewayClientName,
  mcpEndpointFor,
  orgSlugOf,
  sharedToolsSnippets,
  skillsInstallCommand,
  slugify,
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
  it('slugifies to lowercase a-z0-9 with single dashes, trimmed', () => {
    expect(slugify('Swagger Petstore - OpenAPI 3.0')).toBe('swagger-petstore-openapi-3-0')
    expect(slugify('  (Copy) My API!  ')).toBe('copy-my-api')
    expect(slugify('---')).toBe('')
  })

  it('names the client after the address slug, else a clean slug of the name', () => {
    const petstore = { name: 'Swagger Petstore - OpenAPI 3.0', type: 'mcp', endpoint: '/petstore' }
    expect(gatewayClientName(petstore)).toBe('petstore')
    expect(gatewayClientName({ ...petstore, endpoint: null })).toBe('swagger-petstore-openapi-3-0')
    expect(gatewayClientName({ ...petstore, endpoint: '/Swagger_Petstore v2' })).toBe('swagger-petstore-v2')
    expect(gatewayClientName({ name: '', endpoint: '' })).toBe('gateway')
  })

  it('never puts a raw name into claude mcp add or the client JSON keys', () => {
    const petstore = { name: 'Swagger Petstore - OpenAPI 3.0', type: 'mcp', endpoint: null }
    expect(claudeCodeCommand(petstore, 'acme', 'https://x')).toMatch(/^claude mcp add swagger-petstore-openapi-3-0 /)
    for (const snippet of sharedToolsSnippets(petstore, 'acme', 'k', 'https://x')) {
      expect(snippet.value).not.toContain('---')
      if (snippet.language === 'json') expect(Object.keys(JSON.parse(snippet.value).mcpServers)).toEqual(['swagger-petstore-openapi-3-0'])
    }
  })

  it('installs Skills by the address the server resolves, not the display name', () => {
    // GET /gateways/resolve/:org/:slug matches the endpoint first.
    const skills = { name: 'Swagger Petstore - OpenAPI 3.0', type: 'skills', endpoint: '/petstore-skills' }
    expect(skillsInstallCommand(skills, 'acme')).toBe('npx @almyty/skills install @acme/petstore-skills')
  })

  it('leaves no hand-rolled name slug in the gateway screens', () => {
    for (const file of ['components/gateways/detail/integrations-section.tsx', 'components/gateways/detail/gateway-configuration-card.tsx', 'pages/tool-detail.tsx']) {
      const src = readFileSync(join(__dirname, '..', '..', file), 'utf8')
      expect(src, file).not.toMatch(/(gateway|mcpGateway)\.name[^\n]*\.toLowerCase\(\)\.replace\(\/\\s\+\/g/)
    }
  })
})