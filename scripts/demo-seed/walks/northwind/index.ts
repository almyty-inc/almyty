// Northwind AI: the seeded organization behind the reference screenshots,
// and the use-case guides a new customer (Sam Rivera) walks.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Family } from '../../engine/load.ts'
import { seed } from './seed.ts'
import { pages } from './pages.ts'
import { guides } from './guides.ts'

export const northwind: Family = {
  name: 'northwind',
  walks: [seed, ...pages, ...guides],
  actions: {
    /** Write a file a step uploads later: { name, json | text }; answers its path. */
    writeFile: async (run, a) => {
      const dir = join(run.out, 'files')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, String(a.name))
      writeFileSync(file, typeof a.text === 'string' ? a.text : JSON.stringify(a.json))
      return file
    },
    /** Traffic through an MCP gateway, so its metrics and Analytics have something to show: { url, key }. */
    mcpTraffic: async (run, a) => {
      let session: string | null = null
      let id = 0
      const rpc = async (method: string, params: unknown) => {
        const res = await fetch(String(a.url), {
          method: 'POST',
          headers: { 'x-api-key': String(a.key), accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        })
        session = res.headers.get('mcp-session-id') ?? session
        await res.text()
        return res.status
      }
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } })
      await rpc('tools/list', {})
      for (const order of ['NW-10428', 'NW-38801', 'NW-44120']) await rpc('tools/call', { name: 'northwind_orders_get_order', arguments: { orderId: order } })
      await rpc('tools/call', { name: 'northwind_orders_track_shipment', arguments: { orderId: 'NW-10428' } })
      await rpc('tools/call', { name: 'northwind_helpdesk_get_csat_summary', arguments: { days: 7 } })
      run.log('    mcp traffic sent')
      return id
    },
  },
}
