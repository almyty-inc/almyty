// A local stand-in for the outside services the governance example guides
// use (gov-guides.mjs): Stripe (customers, charges, refunds), Splunk Cloud's
// HTTP Event Collector, Microsoft Entra ID's OpenID Connect endpoints, the
// DNS of the made-up company domain, and a scripted OpenAI-compatible model
// (gov-model.mjs). Paths match the real public APIs; only the host differs.
// gov-preload.mjs sends the API's calls to Entra, Splunk and DNS here.
// Nothing here talks to the internet.
//
// The company is Velora Energy (made up): a home and business energy
// supplier in Amsterdam, billing its customers through Stripe.
//
//   USECASE_PORT=4291 node gov-upstream.mjs
//   GET  /_admin/state      refunds made, events Splunk received, mail sent
//   POST /_admin/idp-user   who signs in at the stand-in Entra next
import http from 'node:http'
import { appendFileSync } from 'node:fs'
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'

const PORT = Number(process.env.USECASE_PORT || 4291)
const LOG = process.env.USECASE_LOG || '/tmp/almyty-demo/gov-requests.log'
const now = () => Math.floor(Date.now() / 1000)

// ---------------- Stripe (base https://api.stripe.com) ----------------
const customers = [
  { id: 'cus_QvB7dZonBakkerij', name: 'Bakkerij De Zon B.V.', email: 'administratie@bakkerijdezon.example', description: 'Business contract VE-B-20417, 3 sites (Haarlem)', metadata: { contract: 'VE-B-20417' } },
  { id: 'cus_QvB8kKowalskiA01', name: 'Anna Kowalski', email: 'anna.kowalski@mailbox.example', description: 'Home contract VE-H-88213', metadata: { contract: 'VE-H-88213' } },
  { id: 'cus_QvB9rDeVriesM02', name: 'Maarten de Vries', email: 'maarten.devries@mailbox.example', description: 'Home contract VE-H-90554', metadata: { contract: 'VE-H-90554' } },
]
const day = (d) => now() - d * 86400
const charges = [
  // Bakkerij De Zon's September bill was collected twice by SEPA direct debit.
  { id: 'ch_3QvC1aBakkerijSep01', customer: 'cus_QvB7dZonBakkerij', amount: 624000, description: 'Invoice VE-INV-2026-09-20417 (September 2026)', created: day(9), invoice: 'in_1QvC1aBakkerijSep' },
  { id: 'ch_3QvC1bBakkerijSep02', customer: 'cus_QvB7dZonBakkerij', amount: 624000, description: 'Invoice VE-INV-2026-09-20417 (September 2026)', created: day(8), invoice: 'in_1QvC1aBakkerijSep' },
  { id: 'ch_3QvB0zBakkerijAug01', customer: 'cus_QvB7dZonBakkerij', amount: 587150, description: 'Invoice VE-INV-2026-08-20417 (August 2026)', created: day(39), invoice: 'in_1QvB0zBakkerijAug' },
  // Anna Kowalski was billed on an estimated meter reading; the actual reading was far lower.
  { id: 'ch_3QvC2kKowalskiSep01', customer: 'cus_QvB8kKowalskiA01', amount: 112400, description: 'Annual settlement VE-INV-2026-09-88213 (estimated reading)', created: day(6), invoice: 'in_1QvC2kKowalskiSep' },
  { id: 'ch_3QvB1kKowalskiAug01', customer: 'cus_QvB8kKowalskiA01', amount: 14900, description: 'Monthly advance VE-INV-2026-08-88213', created: day(36), invoice: 'in_1QvB1kKowalskiAug' },
  { id: 'ch_3QvC3dDeVriesSep01', customer: 'cus_QvB9rDeVriesM02', amount: 13650, description: 'Monthly advance VE-INV-2026-09-90554', created: day(7), invoice: 'in_1QvC3dDeVriesSep' },
].map((c) => ({ object: 'charge', currency: 'eur', paid: true, status: 'succeeded', captured: true, refunded: false, amount_refunded: 0, payment_method_details: { type: 'sepa_debit', sepa_debit: { last4: '4417', country: 'NL' } }, livemode: true, ...c }))
const refunds = []
const stripeErr = (status, message, param) => [status, { error: { type: 'invalid_request_error', message, ...(param ? { param } : {}) } }]
const list = (url, data) => ({ object: 'list', data, has_more: false, url })
function stripe(method, p, q, body) {
  let m
  if (p === '/v1/customers/search' && method === 'GET') {
    const query = q.get('query') || ''
    const email = query.match(/email\s*:\s*['"]([^'"]+)['"]/i)?.[1]?.toLowerCase()
    const name = query.match(/name\s*~?:\s*['"]([^'"]+)['"]/i)?.[1]?.toLowerCase()
    const data = customers.filter((c) => (email && c.email === email) || (name && c.name.toLowerCase().includes(name)))
    return [200, { object: 'search_result', data: data.map((c) => ({ object: 'customer', currency: 'eur', livemode: true, ...c })), has_more: false, next_page: null, url: '/v1/customers/search' }]
  }
  if (p === '/v1/customers' && method === 'GET') {
    const email = (q.get('email') || '').toLowerCase()
    const data = customers.filter((c) => !email || c.email === email)
    return [200, list('/v1/customers', data.map((c) => ({ object: 'customer', currency: 'eur', livemode: true, ...c })))]
  }
  if ((m = p.match(/^\/v1\/customers\/(cus_\w+)$/)) && method === 'GET') {
    const c = customers.find((x) => x.id === m[1])
    return c ? [200, { object: 'customer', currency: 'eur', livemode: true, ...c }] : stripeErr(404, `No such customer: '${m[1]}'`, 'id')
  }
  if (p === '/v1/charges' && method === 'GET') {
    const customer = q.get('customer')
    const data = charges.filter((c) => !customer || c.customer === customer).sort((a, b) => b.created - a.created)
    return [200, list('/v1/charges', data)]
  }
  if ((m = p.match(/^\/v1\/charges\/(ch_\w+)$/)) && method === 'GET') {
    const c = charges.find((x) => x.id === m[1])
    return c ? [200, c] : stripeErr(404, `No such charge: '${m[1]}'`, 'id')
  }
  if (p === '/v1/refunds' && method === 'POST') {
    const charge = charges.find((x) => x.id === body?.charge)
    if (!charge) return stripeErr(400, `No such charge: '${body?.charge}'`, 'charge')
    const amount = body.amount != null ? Number(body.amount) : charge.amount - charge.amount_refunded
    if (!Number.isInteger(amount) || amount <= 0) return stripeErr(400, 'Invalid positive integer', 'amount')
    if (amount > charge.amount - charge.amount_refunded) return stripeErr(400, `Refund amount (€${(amount / 100).toFixed(2)}) is greater than unrefunded amount on charge (€${((charge.amount - charge.amount_refunded) / 100).toFixed(2)})`, 'amount')
    charge.amount_refunded += amount
    charge.refunded = charge.amount_refunded === charge.amount
    const refund = { id: `re_3QvD${String(refunds.length + 1).padStart(2, '0')}${charge.id.slice(7, 19)}`, object: 'refund', amount, charge: charge.id, currency: 'eur', created: now(), reason: body.reason || null, status: 'succeeded', metadata: body.metadata || {} }
    refunds.push(refund)
    return [200, refund]
  }
  if (p === '/v1/refunds' && method === 'GET') return [200, list('/v1/refunds', refunds.slice().reverse())]
  return stripeErr(404, `Unrecognized request URL (${method}: ${p}).`)
}

// ---------------- Splunk HTTP Event Collector ----------------
const splunk = []
const SPLUNK_TOKEN = process.env.GOV_SPLUNK_TOKEN || '7c2e9a41-5b1d-4f6a-9e03-8d4b2c1f6a70'

// ---------------- Microsoft Entra ID (OpenID Connect) ----------------
const TENANT = '4f9c2b17-8e3a-4d61-b5a2-0c7e91d3f846'
const ENTRA = 'https://login.microsoftonline.com'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'velora-local-1', use: 'sig', alg: 'RS256' }
const codes = new Map()
let idpUser = { email: 'eva.degroot@veloraenergy.example', given_name: 'Eva', family_name: 'de Groot', oid: '9d3e1f52-7a0b-4c88-9e21-5b6a0f4d2c13' }
const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url')
function idToken(claims) {
  const head = b64u({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })
  const body = b64u(claims)
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')
  return `${head}.${body}.${sig}`
}
function entra(method, p, q, body, req) {
  const base = `${ENTRA}/${TENANT}`
  if (p === `/${TENANT}/v2.0/.well-known/openid-configuration`) {
    return [200, {
      issuer: `${base}/v2.0`, authorization_endpoint: `${base}/oauth2/v2.0/authorize`, token_endpoint: `${base}/oauth2/v2.0/token`,
      jwks_uri: `${base}/discovery/v2.0/keys`, userinfo_endpoint: 'https://graph.microsoft.com/oidc/userinfo', end_session_endpoint: `${base}/oauth2/v2.0/logout`,
      response_types_supported: ['code', 'id_token', 'code id_token', 'id_token token'], response_modes_supported: ['query', 'fragment', 'form_post'],
      subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'], scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt', 'client_secret_basic'], code_challenge_methods_supported: ['plain', 'S256'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'given_name', 'family_name', 'name', 'oid', 'tid', 'preferred_username'], tenant_region_scope: 'EU',
    }]
  }
  if (p === `/${TENANT}/discovery/v2.0/keys`) return [200, { keys: [jwk] }]
  if (p === `/${TENANT}/oauth2/v2.0/authorize`) {
    const code = randomBytes(24).toString('base64url')
    codes.set(code, { clientId: q.get('client_id'), redirectUri: q.get('redirect_uri'), nonce: q.get('nonce'), challenge: q.get('code_challenge'), user: { ...idpUser } })
    const back = new URL(q.get('redirect_uri'))
    back.searchParams.set('code', code)
    back.searchParams.set('state', q.get('state') || '')
    back.searchParams.set('session_state', randomBytes(8).toString('hex'))
    return [302, '', { location: back.href }]
  }
  if (p === `/${TENANT}/oauth2/v2.0/token` && method === 'POST') {
    const grant = codes.get(body.code)
    codes.delete(body.code)
    let clientId = body.client_id
    const basic = String(req.headers.authorization || '').match(/^Basic (.+)$/)
    if (basic) clientId = decodeURIComponent(Buffer.from(basic[1], 'base64').toString().split(':')[0])
    if (!grant || grant.clientId !== clientId || grant.redirectUri !== body.redirect_uri) return [400, { error: 'invalid_grant', error_description: 'AADSTS70008: The provided authorization code or refresh token has expired or is invalid.' }]
    if (grant.challenge && createHash('sha256').update(String(body.code_verifier || '')).digest('base64url') !== grant.challenge) return [400, { error: 'invalid_grant', error_description: 'AADSTS501481: The Code_Verifier does not match the code_challenge supplied in the authorization request.' }]
    const u = grant.user
    const claims = { aud: clientId, iss: `${base}/v2.0`, iat: now(), nbf: now(), exp: now() + 3600, nonce: grant.nonce, sub: createHash('sha256').update(u.oid).digest('base64url').slice(0, 43), oid: u.oid, tid: TENANT, email: u.email, preferred_username: u.email, given_name: u.given_name, family_name: u.family_name, name: `${u.given_name} ${u.family_name}`, ver: '2.0' }
    return [200, { token_type: 'Bearer', scope: 'openid profile email', expires_in: 3599, ext_expires_in: 3599, access_token: randomBytes(32).toString('base64url'), id_token: idToken(claims) }]
  }
  return [404, { error: 'not_found', path: p }]
}

// ---------------- DNS for the made-up domain ----------------
const txt = new Map()

// ---------------- helpers ----------------
const outbox = []
const send = (res, status, body, headers = {}) => {
  const str = typeof body === 'string'
  res.writeHead(status, { 'content-type': str ? 'text/plain; charset=utf-8' : 'application/json', ...headers })
  res.end(str ? body : JSON.stringify(body))
}
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { r(s ? JSON.parse(s) : {}) } catch { r(Object.fromEntries(new URLSearchParams(s))) } }) })
const MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1']
async function chat(req, res, body) {
  const { decide } = await import(`./gov-model.mjs?t=${Date.now()}`)
  const d = await decide(body)
  const model = body.model || MODELS[0]
  const promptTokens = Math.round(JSON.stringify(body.messages || []).length / 4) + 200
  const completionTokens = Math.round(((d.content || '') + JSON.stringify(d.toolCalls || '')).length / 4) + 5
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
  const toolCalls = d.toolCalls?.length ? d.toolCalls.map((c, i) => ({ id: c.id || `call_x_${Date.now() % 1e6}${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) : undefined
  const message = { role: 'assistant', content: d.content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) }
  const finish = toolCalls ? 'tool_calls' : 'stop'
  if (!body.stream) return send(res, 200, { id: 'chatcmpl-local', object: 'chat.completion', created: now(), model, choices: [{ index: 0, message, finish_reason: finish }], usage })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta, finish_reason, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk', created: now(), model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
  if (toolCalls) chunk({ role: 'assistant', tool_calls: toolCalls.map((c, index) => ({ index, ...c })) }, null)
  else for (const piece of (d.content || '').match(/[\s\S]{1,60}/g) || [d.content || '']) chunk({ content: piece }, null)
  chunk({}, finish)
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk', created: now(), model, choices: [], usage })}\n\n`)
  return res.end('data: [DONE]\n\n')
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`)
  const p = decodeURIComponent(u.pathname)
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined
  try { appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${u.pathname}${u.search} ${body ? JSON.stringify(body).slice(0, 600) : ''}\n`) } catch {}
  let m
  try {
    if (p === '/health') return send(res, 200, { ok: true })
    if (p === '/openai/v1/models') return send(res, 200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', created: 1715367049, owned_by: 'openai' })) })
    if (p === '/openai/v1/chat/completions' && req.method === 'POST') return chat(req, res, body)
    if (p.startsWith('/stripe/')) {
      const [status, out] = stripe(req.method, p.slice('/stripe'.length), u.searchParams, body)
      return send(res, status, out, { 'request-id': `req_${randomBytes(7).toString('hex')}` })
    }
    if ((m = p.match(/^\/splunk\/([^/]+)(\/services\/collector(?:\/event)?)$/)) && req.method === 'POST') {
      if (req.headers.authorization !== `Splunk ${SPLUNK_TOKEN}`) return send(res, 403, { text: 'Invalid token', code: 4 })
      splunk.push({ at: new Date().toISOString(), host: m[1], path: m[2], body })
      return send(res, 200, { text: 'Success', code: 0 })
    }
    if (p.startsWith('/entra/')) {
      const [status, out, headers] = entra(req.method, p.slice('/entra'.length), u.searchParams, body || {}, req)
      return send(res, status, out, headers)
    }
    if (p === '/_dns/txt' && req.method === 'GET') return send(res, 200, txt.get(String(u.searchParams.get('name')).toLowerCase()) || [])
    if (p === '/_dns/txt' && req.method === 'POST') { txt.set(String(body.name).toLowerCase(), [String(body.value)]); return send(res, 200, { ok: true }) }
    if (p.startsWith('/_ext/')) {
      outbox.push({ at: new Date().toISOString(), url: p.slice(5) + u.search, body })
      if (p.startsWith('/_ext/api.resend.com')) return send(res, 200, { id: 'local-email-' + outbox.length })
      return send(res, 200, { ok: true, ts: String(Date.now() / 1000), channel: body?.channel || 'C0GENERAL' })
    }
    if (p === '/_admin/idp-user' && req.method === 'POST') { idpUser = { ...idpUser, ...body }; return send(res, 200, idpUser) }
    if (p === '/_admin/state') return send(res, 200, { refunds, splunk, outbox, charges })
    if (p === '/_admin/reset' && req.method === 'POST') { refunds.length = 0; splunk.length = 0; outbox.length = 0; for (const c of charges) { c.amount_refunded = 0; c.refunded = false } return send(res, 200, { reset: true }) }
    return send(res, 404, { error: 'not found in the local stand-in', path: p })
  } catch (e) {
    return send(res, 500, { error: String(e?.stack || e) })
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`governance stand-in on http://localhost:${PORT}`))
http.createServer((req, res) => server.emit('request', req, res)).listen(PORT, '::1')
