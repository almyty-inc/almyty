// Demo harness only, for the Velora Energy governance guides (walks/velora).
// stack.sh loads this into the API with node --import, next to redirect.ts,
// for the velora profile. Three outside services are answered by the local
// fake (fakes/services/velora.ts) instead of the real ones:
//
// - Microsoft Entra ID's sign-in endpoints (login.microsoftonline.com), so
//   single sign-on runs the real OpenID Connect exchange against a local IdP.
// - Splunk Cloud's HTTP Event Collector (*.splunkcloud.com), so the audit
//   stream is delivered and can be shown as Splunk received it.
// - DNS TXT lookups for the made-up company domain, so "Check DNS" finds the
//   record the guide adds at the fake's DNS.
//
// Nothing else is touched. The fake's address is the profile's redirect port
// (USECASE_UPSTREAM_URL, which stack.sh sets, offset included).
import dns from 'node:dns'

const UP = process.env.USECASE_UPSTREAM_URL || 'http://localhost:4291'
const DOMAIN = process.env.GOV_DEMO_DOMAIN || 'veloraenergy.example'
const realFetch = globalThis.fetch

const target = (url: URL): string | null => {
  if (url.hostname === 'login.microsoftonline.com') return `${UP}/entra${url.pathname}${url.search}`
  if (url.hostname.endsWith('.splunkcloud.com')) return `${UP}/splunk/${url.hostname}${url.pathname}${url.search}`
  return null
}

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const to = target(url)
    if (to) {
      const { dispatcher: _d, agent: _a, ...rest } = (init ?? {}) as RequestInit & { dispatcher?: unknown; agent?: unknown }
      if (!init && typeof input === 'object' && !(input instanceof URL)) {
        return realFetch(to, { method: input.method, headers: input.headers, body: input.body ? await input.text() : undefined, redirect: input.redirect })
      }
      return realFetch(to, rest)
    }
  } catch { /* not a URL we know */ }
  return realFetch(input, init)
}

const realResolveTxt = dns.promises.resolveTxt.bind(dns.promises)
dns.promises.resolveTxt = async (name: string) => {
  if (String(name).toLowerCase().endsWith(DOMAIN)) {
    const res = await realFetch(`${UP}/_dns/txt?name=${encodeURIComponent(name)}`)
    const records = (await res.json()) as string[]
    if (!records.length) {
      const err = Object.assign(new Error(`queryTxt ENODATA ${name}`), { code: 'ENODATA' })
      throw err
    }
    return records.map((r) => [r])
  }
  return realResolveTxt(name)
}
