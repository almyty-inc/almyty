#!/usr/bin/env node
// Connects to an MCP gateway with the official TypeScript SDK client at a
// pinned version, so each protocol version the docs claim is exercised by the
// client that speaks it (MCP Inspector always negotiates its newest one).
//
//   node sdk-check.mjs <sdk node_modules dir> <server url> <expected version>
//
// Exits non-zero unless the negotiated version is the expected one, tools/list
// returns tools, and test_simple_text answers.
import { createRequire } from 'node:module'
import { join } from 'node:path'

const [sdkDir, url, expected] = process.argv.slice(2)
if (!sdkDir || !url || !expected) {
  console.error('usage: sdk-check.mjs <sdk node_modules dir> <server url> <expected version>')
  process.exit(2)
}
const require = createRequire(join(sdkDir, 'noop.js'))
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

// The negotiated version, read off the initialize answer itself: older SDKs
// do not expose it.
let negotiatedFromWire
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init)
  if (typeof init?.body === 'string' && init.body.includes('"initialize"')) {
    try {
      const text = await res.clone().text()
      const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:')).slice(5))
      negotiatedFromWire = json?.result?.protocolVersion
    } catch {}
  }
  return res
}

const client = new Client({ name: 'almyty-sdk-check', version: '1.0.0' }, { capabilities: {} })
const transport = new StreamableHTTPClientTransport(new URL(url))
await client.connect(transport)
const negotiated = negotiatedFromWire ?? transport.protocolVersion
const { tools } = await client.listTools()
const simple = tools.find((t) => t.name === 'test_simple_text')
const called = simple ? await client.callTool({ name: 'test_simple_text', arguments: {} }) : null
await client.close()

const report = { expected, negotiated, tools: tools.length, simpleText: called?.content?.[0]?.text ?? null }
console.log(JSON.stringify(report))
if (negotiated !== expected || tools.length === 0 || (simple && !report.simpleText)) process.exit(1)
