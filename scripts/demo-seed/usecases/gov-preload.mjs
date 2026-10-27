// Demo harness only, for the governance example guides (gov-guides.mjs).
// Loaded into the API with node --import, next to redirect-fetch.mjs, when
// the stack runs for those guides. Three outside services are answered by
// the local stand-in (gov-upstream.mjs) instead of the real ones:
//
// - Microsoft Entra ID's sign-in endpoints (login.microsoftonline.com), so
//   single sign-on runs the real OpenID Connect exchange against a local IdP.
// - Splunk Cloud's HTTP Event Collector (*.splunkcloud.com), so the audit
//   stream is delivered and can be shown as Splunk received it.
// - DNS TXT lookups for the made-up company domain, so "Check DNS" finds the
//   record the guide adds at the stand-in's DNS.
//
// Nothing else is touched.
import dns from 'node:dns'

const UP = process.env.USECASE_UPSTREAM_URL || 'http://localhost:4291'
const DOMAIN = process.env.GOV_DEMO_DOMAIN || 'veloraenergy.example'
const realFetch = globalThis.fetch
const route = (url) => {
  if (url.hostname === 'login.microsoftonline.com') return `${UP}/entra${url.pathname}${url.search}`
  if (url.hostname.endsWith('.splunkcloud.com')) return `${UP}/splunk/${url.hostname}${url.pathname}${url.search}`
  return null
}
globalThis.fetch = async (input, init) => {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const to = route(url)
    if (to) {
      const { dispatcher, agent, ...rest } = init || {}
      if (!init && typeof input === 'object' && !(input instanceof URL)) {
        return realFetch(to, { method: input.method, headers: input.headers, body: input.body ? await input.text() : undefined, redirect: input.redirect })
      }
      return realFetch(to, rest)
    }
  } catch {}
  return realFetch(input, init)
}

const realResolveTxt = dns.promises.resolveTxt.bind(dns.promises)
dns.promises.resolveTxt = async (name) => {
  if (String(name).toLowerCase().endsWith(DOMAIN)) {
    const res = await realFetch(`${UP}/_dns/txt?name=${encodeURIComponent(name)}`)
    const records = await res.json()
    if (!records.length) {
      const err = new Error(`queryTxt ENODATA ${name}`)
      err.code = 'ENODATA'
      throw err
    }
    return records.map((r) => [r])
  }
  return realResolveTxt(name)
}
