// Demo harness only: stack.sh loads this into the API with node --import
// when the profile names a redirect port. The API's calls to Resend (email),
// Slack (messages and shared files) and Telegram go to the local fake
// instead, so no real email, Slack or Telegram message is ever sent.
// Everything else is untouched.
const FAKE = `${process.env.USECASE_UPSTREAM_URL || 'http://localhost:4291'}/_ext`
const HOSTS = new Set(['api.resend.com', 'slack.com', 'hooks.slack.com', 'files.slack.com', 'api.telegram.org'])
const realFetch = globalThis.fetch
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (HOSTS.has(url.hostname)) {
      const { dispatcher: _d, agent: _a, ...rest } = (init ?? {}) as RequestInit & { dispatcher?: unknown; agent?: unknown }
      return realFetch(`${FAKE}/${url.hostname}${url.pathname}${url.search}`, rest)
    }
  } catch { /* not a URL we know */ }
  return realFetch(input, init)
}
