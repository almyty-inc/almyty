/**
 * The organization page's Gateways stat and limit count the plan's
 * gateways only: MCP, UTCP and Skills. Channels (web chat, widget,
 * messaging, A2A) are an agent's and do not count, nor does the platform's
 * system gateway.
 */
import { describe, it, expect } from 'vitest'

import { planGatewayCount } from '../organization-detail'

describe('planGatewayCount', () => {
  it('counts MCP, UTCP and Skills gateways and nothing else', () => {
    const gateways = [
      { id: '1', type: 'mcp' },
      { id: '2', type: 'utcp' },
      { id: '3', type: 'skills' },
      { id: '4', type: 'hosted_chat' },
      { id: '5', type: 'chat_widget' },
      { id: '6', type: 'slack' },
      { id: '7', type: 'a2a' },
      { id: '8', type: 'mcp', isSystem: true },
    ]
    expect(planGatewayCount({ gateways } as any)).toBe(3)
    expect(planGatewayCount({} as any)).toBe(0)
  })
})
