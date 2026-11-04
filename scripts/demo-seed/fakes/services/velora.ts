// The outside world of the Velora Energy governance guides (walks/velora),
// on one local port: Stripe (customers, charges, refunds), Splunk Cloud's
// HTTP Event Collector, Microsoft Entra ID's OpenID Connect endpoints, the
// DNS of the made-up company domain, the outbox for redirected email and
// Slack, and a scripted OpenAI-compatible model (fakes/models/velora.ts).
// Paths match the real public APIs; only the host differs.
// fakes/preload/velora.ts sends the API's calls to Entra, Splunk and DNS here.
//
// The company is Velora Energy (made up): a home and business energy
// supplier in Amsterdam, billing its customers through Stripe.
//
//   GET  /_admin/state      refunds made, events Splunk received, mail sent, charges
//   POST /_admin/idp-user   who signs in at the stand-in Entra next
//   POST /_admin/reset      forget refunds, events and mail
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { any, get, json, post, type Reply, type Req, type Service } from '../server.ts'
import { vendor } from '../openai.ts'
import { outbox } from '../outbox.ts'
import { decide, usage } from '../models/velora.ts'

const now = () => Math.floor(Date.now() / 1000)
const day = (d: number) => now() - d * 86400

// ---------- Stripe (base https://api.stripe.com) ----------

export const CUSTOMERS = [
  { id: 'cus_QvB7dZonBakkerij', name: 'Bakkerij De Zon B.V.', email: 'administratie@bakkerijdezon.example', description: 'Business contract VE-B-20417, 3 sites (Haarlem)', metadata: { contract: 'VE-B-20417' } },
  { id: 'cus_QvB8kKowalskiA01', name: 'Anna Kowalski', email: 'anna.kowalski@mailbox.example', description: 'Home contract VE-H-88213', metadata: { contract: 'VE-H-88213' } },
  { id: 'cus_QvB9rDeVriesM02', name: 'Maarten de Vries', email: 'maarten.devries@mailbox.example', description: 'Home contract VE-H-90554', metadata: { contract: 'VE-H-90554' } },
]

export const CHARGES: any[] = [
  // Bakkerij De Zon's September bill was collected twice by SEPA direct debit.
  { id: 'ch_3QvC1aBakkerijSep01', customer: 'cus_QvB7dZonBakkerij', amount: 624000, description: 'Invoice VE-INV-2026-09-20417 (September 2026)', created: day(9), invoice: 'in_1QvC1aBakkerijSep' },
  { id: 'ch_3QvC1bBakkerijSep02', customer: 'cus_QvB7dZonBakkerij', amount: 624000, description: 'Invoice VE-INV-2026-09-20417 (September 2026)', created: day(8), invoice: 'in_1QvC1aBakkerijSep' },
  { id: 'ch_3QvB0zBakkerijAug01', customer: 'cus_QvB7dZonBakkerij', amount: 587150, description: 'Invoice VE-INV-2026-08-20417 (August 2026)', created: day(39), invoice: 'in_1QvB0zBakkerijAug' },
  // Anna Kowalski was billed on an estimated meter reading; the actual reading was far lower.
  { id: 'ch_3QvC2kKowalskiSep01', customer: 'cus_QvB8kKowalskiA01', amount: 112400, description: 'Annual settlement VE-INV-2026-09-88213 (estimated reading)', created: day(6), invoice: 'in_1QvC2kKowalskiSep' },
  { id: 'ch_3QvB1kKowalskiAug01', customer: 'cus_QvB8kKowalskiA01', amount: 14900, description: 'Monthly advance VE-INV-2026-08-88213', created: day(36), invoice: 'in_1QvB1kKowalskiAug' },
  { id: 'ch_3QvC3dDeVriesSep01', customer: 'cus_QvB9rDeVriesM02', amount: 13650, description: 'Monthly advance VE-INV-2026-09-90554', created: day(7), invoice: 'in_1QvC3dDeVriesSep' },
].map((c) => ({ object: 'charge', currency: 'eur', paid: true, status: 'succeeded', captured: true, refunded: false, amount_refunded: 0, payment_method_details: { type: 'sepa_debit', sepa_debit: { last4: '4417', country: 'NL' } }, livemode: true, ...c }))

const refunds: any[] = []
const asCustomer = (c: (typeof CUSTOMERS)[number]) => ({ object: 'customer', currency: 'eur', livemode: true, ...c })
const stripeErr = (status: number, message: string, param?: string): [number, unknown] => [status, { error: { type: 'invalid_request_error', message, ...(param ? { param } : {}) } }]
const list = (url: string, data: unknown[]) => ({ object: 'list', data, has_more: false, url })

/** Stripe's answer to one request: [status, body]. Bodies come form-encoded, as Stripe takes them. */
export function stripe(method: string, p: string, q: URLSearchParams, body: any): [number, unknown] {
  let m: RegExpMatchArray | null
  if (p === '/v1/customers/search' && method === 'GET') {
    const query = q.get('query') || ''
    const email = query.match(/email\s*:\s*['"]([^'"]+)['"]/i)?.[1]?.toLowerCase()
    const name = query.match(/name\s*~?:\s*['"]([^'"]+)['"]/i)?.[1]?.toLowerCase()
    const data = CUSTOMERS.filter((c) => (email && c.email === email) || (name && c.name.toLowerCase().includes(name)))
    return [200, { object: 'search_result', data: data.map(asCustomer), has_more: false, next_page: null, url: '/v1/customers/search' }]
  }
  if (p === '/v1/customers' && method === 'GET') {
    const email = (q.get('email') || '').toLowerCase()
    return [200, list('/v1/customers', CUSTOMERS.filter((c) => !email || c.email === email).map(asCustomer))]
  }
  if ((m = p.match(/^\/v1\/customers\/(cus_\w+)$/)) && method === 'GET') {
    const id = m[1]
    const c = CUSTOMERS.find((x) => x.id === id)
    return c ? [200, asCustomer(c)] : stripeErr(404, `No such customer: '${id}'`, 'id')
  }
  if (p === '/v1/charges' && method === 'GET') {
    const customer = q.get('customer')
    return [200, list('/v1/charges', CHARGES.filter((c) => !customer || c.customer === customer).sort((a, b) => b.created - a.created))]
  }
  if ((m = p.match(/^\/v1\/charges\/(ch_\w+)$/)) && method === 'GET') {
    const id = m[1]
    const c = CHARGES.find((x) => x.id === id)
    return c ? [200, c] : stripeErr(404, `No such charge: '${id}'`, 'id')
  }
  if (p === '/v1/refunds' && method === 'POST') {
    const charge = CHARGES.find((x) => x.id === body?.charge)
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

// ---------- Splunk HTTP Event Collector ----------

const splunk: { at: string; host: string; path: string; body: any }[] = []
const SPLUNK_TOKEN = process.env.GOV_SPLUNK_TOKEN || '7c2e9a41-5b1d-4f6a-9e03-8d4b2c1f6a70'

// ---------- Microsoft Entra ID (OpenID Connect) ----------

export const TENANT = '4f9c2b17-8e3a-4d61-b5a2-0c7e91d3f846'
const ENTRA = 'https://login.microsoftonline.com'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'velora-local-1', use: 'sig', alg: 'RS256' }
interface IdpUser { email: string; given_name: string; family_name: string; oid: string }
const codes = new Map<string, { clientId: string | null; redirectUri: string | null; nonce: string | null; challenge: string | null; user: IdpUser }>()
let idpUser: IdpUser = { email: 'eva.degroot@veloraenergy.example', given_name: 'Eva', family_name: 'de Groot', oid: '9d3e1f52-7a0b-4c88-9e21-5b6a0f4d2c13' }
const b64u = (x: unknown) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url')
function idToken(claims: object): string {
  const head = b64u({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })
  const body = b64u(claims)
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')
  return `${head}.${body}.${sig}`
}

export function entra(method: string, p: string, q: URLSearchParams, body: any, authorization?: string): Reply {
  const base = `${ENTRA}/${TENANT}`
  if (p === `/${TENANT}/v2.0/.well-known/openid-configuration`) {
    return json({
      issuer: `${base}/v2.0`, authorization_endpoint: `${base}/oauth2/v2.0/authorize`, token_endpoint: `${base}/oauth2/v2.0/token`,
      jwks_uri: `${base}/discovery/v2.0/keys`, userinfo_endpoint: 'https://graph.microsoft.com/oidc/userinfo', end_session_endpoint: `${base}/oauth2/v2.0/logout`,
      response_types_supported: ['code', 'id_token', 'code id_token', 'id_token token'], response_modes_supported: ['query', 'fragment', 'form_post'],
      subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'], scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt', 'client_secret_basic'], code_challenge_methods_supported: ['plain', 'S256'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'given_name', 'family_name', 'name', 'oid', 'tid', 'preferred_username'], tenant_region_scope: 'EU',
    })
  }
  if (p === `/${TENANT}/discovery/v2.0/keys`) return json({ keys: [jwk] })
  if (p === `/${TENANT}/oauth2/v2.0/authorize`) {
    const code = randomBytes(24).toString('base64url')
    codes.set(code, { clientId: q.get('client_id'), redirectUri: q.get('redirect_uri'), nonce: q.get('nonce'), challenge: q.get('code_challenge'), user: { ...idpUser } })
    const back = new URL(q.get('redirect_uri') || '')
    back.searchParams.set('code', code)
    back.searchParams.set('state', q.get('state') || '')
    back.searchParams.set('session_state', randomBytes(8).toString('hex'))
    return { status: 302, redirect: back.href }
  }
  if (p === `/${TENANT}/oauth2/v2.0/token` && method === 'POST') {
    const grant = codes.get(body.code)
    codes.delete(body.code)
    let clientId = body.client_id
    const basic = String(authorization || '').match(/^Basic (.+)$/)
    if (basic) clientId = decodeURIComponent(Buffer.from(basic[1], 'base64').toString().split(':')[0])
    if (!grant || grant.clientId !== clientId || grant.redirectUri !== body.redirect_uri) return json({ error: 'invalid_grant', error_description: 'AADSTS70008: The provided authorization code or refresh token has expired or is invalid.' }, 400)
    if (grant.challenge && createHash('sha256').update(String(body.code_verifier || '')).digest('base64url') !== grant.challenge) return json({ error: 'invalid_grant', error_description: 'AADSTS501481: The Code_Verifier does not match the code_challenge supplied in the authorization request.' }, 400)
    const u = grant.user
    const claims = { aud: clientId, iss: `${base}/v2.0`, iat: now(), nbf: now(), exp: now() + 3600, nonce: grant.nonce, sub: createHash('sha256').update(u.oid).digest('base64url').slice(0, 43), oid: u.oid, tid: TENANT, email: u.email, preferred_username: u.email, given_name: u.given_name, family_name: u.family_name, name: `${u.given_name} ${u.family_name}`, ver: '2.0' }
    return json({ token_type: 'Bearer', scope: 'openid profile email', expires_in: 3599, ext_expires_in: 3599, access_token: randomBytes(32).toString('base64url'), id_token: idToken(claims) })
  }
  return json({ error: 'not_found', path: p }, 404)
}

// ---------- DNS for the made-up domain ----------

const txt = new Map<string, string[]>()

// ---------- the service ----------

/** A body as the old stand-in read it: JSON, or else form fields (Stripe and the token endpoint take forms). */
export const fields = (req: Req): any => (req.body && typeof req.body === 'object' && '_raw' in req.body ? Object.fromEntries(new URLSearchParams(req.raw)) : req.body)

const MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'].map((id) => ({ id, created: 1715367049, owned_by: 'openai' }))
const box = outbox()

export const velora: Service = {
  name: 'velora',
  routes: [
    ...vendor({
      prefix: '/openai', models: MODELS, decide, usage, embeddings: false,
      completionId: 'chatcmpl-local', created: now,
      chunks: (c) => c.match(/[\s\S]{1,60}/g) || [c],
    }),
    any(/^\/stripe\//, (req) => {
      const [status, out] = stripe(req.method, req.path.slice('/stripe'.length), req.query, fields(req))
      return json(out, status, { 'request-id': `req_${randomBytes(7).toString('hex')}` })
    }),
    post(/^\/splunk\/([^/]+)(\/services\/collector(?:\/event)?)$/, (req, m) => {
      if (req.headers.authorization !== `Splunk ${SPLUNK_TOKEN}`) return json({ text: 'Invalid token', code: 4 }, 403)
      splunk.push({ at: new Date().toISOString(), host: m[1], path: m[2], body: fields(req) })
      return json({ text: 'Success', code: 0 })
    }),
    any(/^\/entra\//, (req) => entra(req.method, req.path.slice('/entra'.length), req.query, fields(req), req.headers.authorization)),
    get('/_dns/txt', (req) => json(txt.get(String(req.query.get('name')).toLowerCase()) || [])),
    post('/_dns/txt', (req) => { txt.set(String(req.body.name).toLowerCase(), [String(req.body.value)]); return json({ ok: true }) }),
    ...box.routes,
    post('/_admin/idp-user', (req) => { idpUser = { ...idpUser, ...req.body }; return json(idpUser) }),
    get('/_admin/state', () => json({ refunds, splunk, outbox: box.sent, charges: CHARGES })),
    post('/_admin/reset', () => {
      refunds.length = 0; splunk.length = 0; box.sent.length = 0
      for (const c of CHARGES) { c.amount_refunded = 0; c.refunded = false }
      return json({ reset: true })
    }),
  ],
}
