import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import config, { VITE_OWN_SEGMENTS, gatewayPathPattern, spaRouteSegments } from '../../vite.config'

/**
 * Gateway endpoints live at /<org>/<gateway>/... (the backend's unified
 * endpoint). Neither segment is a fixed prefix, so the dev proxy had no
 * rule for them and an MCP client pointed at `npm run dev` got index.html.
 */
describe('vite dev proxy: gateway paths', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8')
  const pattern = new RegExp(gatewayPathPattern([...VITE_OWN_SEGMENTS, ...spaRouteSegments(app)]))
  const proxy = (config as any).server.proxy as Record<string, unknown>

  it('sends /<org>/<gateway> and its sub-paths to the API', () => {
    for (const p of ['/acme/support', '/acme/support/mcp', '/acme/support/.well-known/agent-card.json', '/acme/support/authorize?x=1', '/acme/ops/webhook']) {
      expect(pattern.test(p)).toBe(true)
    }
  })

  it('leaves vite\'s own files and the SPA\'s pages alone', () => {
    for (const p of ['/src/main.tsx', '/node_modules/.vite/deps/react.js', '/@vite/client', '/@fs/x/y', '/apis/new', '/settings/billing', '/agents/abc/edit', '/favicon.svg', '/acme', '/.well-known/openid']) {
      expect(pattern.test(p)).toBe(false)
    }
  })

  it('is the last rule, so every fixed prefix is tried first, and reads the router', () => {
    const keys = Object.keys(proxy)
    const last = keys[keys.length - 1]
    expect(last.startsWith('^/')).toBe(true)
    const live = new RegExp(last)
    expect(live.test('/acme/support/mcp')).toBe(true)
    expect(live.test('/tools/new')).toBe(false)
    expect(spaRouteSegments(app)).toEqual(expect.arrayContaining(['apis', 'settings', 'agents']))
  })
})
