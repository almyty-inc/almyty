#!/usr/bin/env node
// Seeds a backend for the MCP conformance and MCP Inspector checks
// (.github/workflows/ci.yml, job mcp-conformance; docs/design/mcp-2026-07-28.md).
//
// Creates, through the public REST API, one user and organization and two MCP
// gateways reachable with an API key in the query string (the conformance
// runner cannot add headers):
//
//   conformance  JavaScript tools named after the conformance suite's fixtures
//                that an almyty gateway can serve: test_simple_text,
//                test_error_handling, json_schema_2020_12_tool
//   petstore     the tools generated from the Petstore OpenAPI document
//
// Prints KEY=value lines (CONFORMANCE_URL, PETSTORE_URL, ...) for $GITHUB_ENV.
//
//   MCP_SEED_API=http://localhost:4000 DATABASE_URL=postgresql://... node scripts/mcp-conformance/seed.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const API = (process.env.MCP_SEED_API || 'http://localhost:4000').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/almyty_e2e'
const PETSTORE_URL = process.env.MCP_SEED_PETSTORE_URL || 'https://petstore3.swagger.io/api/v3/openapi.json'
const USER = {
  email: 'conformance@almyty.test',
  // A throwaway credential for a throwaway CI database.
  password: 'Conformance-local-2026!',
  firstName: 'MCP',
  lastName: 'Conformance',
  organizationName: 'MCP Conformance',
}

const log = (...a) => console.error('-', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let token = ''

async function call(method, path, body, ok = [200, 201, 204]) {
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!ok.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`)
  return json && typeof json === 'object' && 'data' in json && 'success' in json ? json.data : json
}
const list = (x, key) => (Array.isArray(x) ? x : x?.[key] ?? x?.items ?? x?.data ?? [])

async function signIn(db) {
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE email = $1', [USER.email])
  if (!rowCount) await call('POST', '/auth/register', USER)
  await db.query('UPDATE users SET "isVerified" = true, "verifiedAt" = coalesce("verifiedAt", now()) WHERE email = $1', [USER.email])
  token = (await call('POST', '/auth/token', { email: USER.email, password: USER.password })).accessToken
  const { rows } = await db.query(
    `SELECT o.id, o.slug FROM organizations o
       JOIN user_organizations uo ON uo."organizationId" = o.id
       JOIN users u ON u.id = uo."userId"
      WHERE u.email = $1 LIMIT 1`,
    [USER.email],
  )
  return rows[0]
}

/** The conformance fixtures an almyty JavaScript tool can be. */
const FIXTURES = [
  {
    name: 'test_simple_text',
    description: 'Returns a fixed text (MCP conformance fixture).',
    parameters: { type: 'object', properties: {} },
    code: "return 'This is a simple text response for testing.'",
  },
  {
    name: 'test_error_handling',
    description: 'Always fails (MCP conformance fixture).',
    parameters: { type: 'object', properties: {} },
    code: "throw new Error('This tool intentionally returns an error for testing')",
  },
  {
    name: 'json_schema_2020_12_tool',
    description: 'Tool with JSON Schema 2020-12 features (MCP conformance fixture).',
    // The 2026-07-28 fixture: the 2025-11-25 one plus $anchor, allOf/anyOf
    // and if/then/else (SEP-1613, SEP-2106).
    parameters: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: {
        address: {
          $anchor: 'addressDef',
          type: 'object',
          properties: { street: { type: 'string' }, city: { type: 'string' } },
        },
      },
      properties: {
        name: { type: 'string' },
        address: { $ref: '#/$defs/address' },
        contactMethod: { type: 'string', enum: ['phone', 'email'] },
        phone: { type: 'string' },
        email: { type: 'string' },
      },
      allOf: [{ anyOf: [{ required: ['phone'] }, { required: ['email'] }] }],
      if: { properties: { contactMethod: { const: 'phone' } }, required: ['contactMethod'] },
      then: { required: ['phone'] },
      else: { required: ['email'] },
      additionalProperties: false,
    },
    code: 'return { received: parameters }',
  },
  {
    // A parameter mirrored into an Mcp-Param-Region header (x-mcp-header,
    // 2026-07-28), so the server's header validation can be exercised.
    name: 'test_region_header',
    description: 'Echoes a region carried in an Mcp-Param header (MCP conformance fixture).',
    parameters: {
      type: 'object',
      properties: {
        region: { type: 'string', description: 'Region', 'x-mcp-header': 'Region' },
      },
      required: ['region'],
    },
    code: 'return { region: parameters.region }',
  },
]

async function fixtureTools(orgId) {
  const have = list(await call('GET', `/organizations/${orgId}/tools?limit=100`), 'tools')
  const ids = []
  for (const f of FIXTURES) {
    let row = have.find((t) => t.name === f.name)
    if (!row) {
      row = await call('POST', `/organizations/${orgId}/tools`, { ...f, type: 'function', executionMethod: 'custom' })
      log('tool', f.name)
    } else {
      // Keep a rerun in step with the fixture definitions above.
      row = await call('PUT', `/organizations/${orgId}/tools/${row.id}`, { parameters: f.parameters, code: f.code, description: f.description })
    }
    if (row.status !== 'active') await call('POST', `/organizations/${orgId}/tools/${row.id}/activate`)
    ids.push(row.id)
  }
  return ids
}

async function petstoreTools(orgId) {
  const prefix = 'petstore_'
  let tools = list(await call('GET', `/organizations/${orgId}/tools?limit=100`), 'tools').filter((t) => t.name.startsWith(prefix))
  if (!tools.length) {
    let request = { url: PETSTORE_URL, type: 'openapi', name: 'Petstore', generateTools: true }
    try {
      const probe = await fetch(PETSTORE_URL, { signal: AbortSignal.timeout(10_000) })
      if (!probe.ok) throw new Error(`HTTP ${probe.status}`)
    } catch (e) {
      // Offline: the parser fixture is the same Petstore, minus a live server to call.
      log('petstore url unreachable, using the fixture:', e.message)
      const content = readFileSync(join(HERE, '../../src/modules/schema-parser/__fixtures__/openapi3-petstore.json'), 'utf8')
      request = { content, type: 'openapi', name: 'Petstore', generateTools: true }
    }
    const r = await call('POST', '/apis/import', request)
    for (let i = 0; i < 90; i++) {
      const s = await call('GET', `/apis/${r.api.id}/import-status/${r.jobId}`)
      if (s?.status === 'completed') break
      if (s?.status === 'failed') throw new Error(`petstore import failed: ${s.error}`)
      await sleep(1000)
    }
    tools = list(await call('GET', `/organizations/${orgId}/tools?limit=100`), 'tools').filter((t) => t.name.startsWith(prefix))
    log('api Petstore,', tools.length, 'tools')
  }
  for (const t of tools) if (t.status !== 'active') await call('POST', `/organizations/${orgId}/tools/${t.id}/activate`)
  return tools.map((t) => t.id)
}

async function gateway(name, endpoint, toolIds, { open = false } = {}) {
  const have = list(await call('GET', '/gateways'), 'gateways')
  let row = have.find((g) => g.name === name)
  if (!row) {
    row = await call('POST', '/gateways', { name, type: 'mcp', endpoint, configuration: { transport: 'http' }, toolIds, kind: 'tool', visibility: 'org', accessScope: open ? 'external_open' : 'external_protected' })
    log('gateway', name)
  } else {
    await call('POST', `/gateways/${row.id}/tools/bulk`, { toolIds }).catch(() => undefined)
  }
  await call('PATCH', `/gateways/${row.id}`, { accessScope: open ? 'external_open' : 'external_protected' })
  if (!open) {
    const auths = list(await call('GET', `/gateways/${row.id}/auth`), 'auths')
    if (!auths.some(a => a.type === 'api_key' && a.isActive)) await call('POST', `/gateways/${row.id}/auth`, { type: 'api_key', isRequired: true, configuration: { keyHeader: 'x-api-key', keyQuery: 'api_key' } })
  }
  if (!open && !row.initialApiKey) {
    const key = await call('POST', `/gateways/${row.id}/auth/api-keys`, { name: `ci-${Date.now()}` })
    row.initialApiKey = key?.apiKey ?? key?.key ?? key?.plainKey
  }
  if (open) {
    // The conformance runner builds some requests itself and drops the
    // URL's query string, so the api_key there does not reach the server.
    // This fixture gateway (test tools only, on a throwaway CI database)
    // answers without credentials instead.
    const auths = list(await call('GET', `/gateways/${row.id}/auth`), 'auths')
    for (const a of auths) if (a.type !== 'none') await call('DELETE', `/gateways/${row.id}/auth/${a.id}`)

  }
  return row
}

const db = new pg.Client({ connectionString: DATABASE_URL })
await db.connect()
try {
  const org = await signIn(db)
  const conformance = await gateway('MCP conformance', '/conformance', await fixtureTools(org.id), { open: true })
  const petstore = await gateway('Petstore', '/petstore', await petstoreTools(org.id))
  const out = {
    MCP_ORG_SLUG: org.slug,
    CONFORMANCE_URL: `${API}/${org.slug}/conformance`,
    PETSTORE_URL: `${API}/${org.slug}/petstore?api_key=${petstore.initialApiKey}`,
    PETSTORE_API_KEY: petstore.initialApiKey,
  }
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`)
} finally {
  await db.end()
}
