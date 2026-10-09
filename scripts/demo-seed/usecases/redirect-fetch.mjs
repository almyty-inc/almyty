// Demo harness only (stack.sh loads it with node --import when USECASES=1): the API's outbound calls to
// Resend (email) and Slack go to the local fake upstream instead, so no
// real email or Slack message is ever sent. Everything else is untouched.
const FAKE = `${process.env.USECASE_UPSTREAM_URL || 'http://localhost:4291'}/_ext`
const HOSTS = new Set(['api.resend.com', 'slack.com', 'hooks.slack.com'])
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (HOSTS.has(url.hostname)) {
      const to = `${FAKE}/${url.hostname}${url.pathname}${url.search}`
      const { dispatcher, agent, ...rest } = init || {}
      return realFetch(to, rest)
    }
  } catch {}
  return realFetch(input, init)
}
