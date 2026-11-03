// Demo harness only (stack.sh loads it with node --import when USECASES=1): the API's outbound calls to
// Resend (email), Slack (messages and shared files) and Telegram go to the local fake upstream instead,
// so no real email, Slack or Telegram message is ever sent. Everything else is untouched.
const FAKE = `${process.env.USECASE_UPSTREAM_URL || 'http://localhost:4291'}/_ext`
const HOSTS = new Set(['api.resend.com', 'slack.com', 'hooks.slack.com', 'files.slack.com', 'api.telegram.org'])
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
