import axios from 'axios'

/**
 * Client for the public hosted chat app served at {slug}.<base domain>.
 *
 * Calls are SAME-ORIGIN under /api, never the dashboard's cross-origin
 * API host. That is not a style choice: the session cookie identifying
 * an anonymous visitor is set by the API without an explicit Domain, so
 * it is scoped to whatever host served the request. Pointing these calls
 * at api.almyty.com would set the cookie there instead, and every
 * visitor would look new on every request. The ingress routes /api on a
 * tenant host to the API service for exactly this reason.
 *
 * Deliberately its own axios instance rather than the dashboard's: the
 * dashboard client carries auth interceptors and redirects to /login on
 * a 401, which is exactly the wrong behaviour for a page whose visitors
 * are anonymous members of the public. Everything here is
 * unauthenticated, and the only credential is the httpOnly session
 * cookie the API sets for the visitor.
 */
let instance: ReturnType<typeof axios.create> | null = null

/**
 * Built on first use rather than at import time. The base URL is read
 * from the dashboard client's runtime config, which is not necessarily
 * settled while modules are still evaluating.
 */
/** Same-origin API prefix, matched by the hosted-chat ingress rule. */
export const HOSTED_CHAT_API_PREFIX = '/api'

function client() {
  if (!instance) {
    instance = axios.create({
      baseURL: HOSTED_CHAT_API_PREFIX,
      // Carries the anonymous session cookie. Scoped to this tenant's
      // host by the API, so it cannot be replayed against another tenant.
      withCredentials: true,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return instance
}

export interface HostedChatBranding {
  appName: string
  primaryColor: string
  greeting: string
  theme: 'dark' | 'light' | 'auto'
  logoUrl: string | null
  suggestedPrompts: string[]
  authMode: 'public_link' | 'email_otp' | 'oauth' | 'sso'
  whiteLabel: boolean
  aiDisclosure: string | null
}

export interface HostedChatConversation {
  id: string
  title: string
  createdAt: string
}

export interface HostedChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

/** Mirrors ChannelGatewayService.DEFAULT_AI_DISCLOSURE on the backend. */
export const DEFAULT_AI_DISCLOSURE = 'You are chatting with an AI assistant.'

/**
 * The disclosure line to render, given what the surface configured.
 * Null means "use the default"; an empty string is a deliberate removal
 * that publishing already gated on the white-label entitlement.
 */
export function disclosureLine(branding: Pick<HostedChatBranding, 'aiDisclosure'>): string | null {
  if (branding.aiDisclosure === null || branding.aiDisclosure === undefined) {
    return DEFAULT_AI_DISCLOSURE
  }
  const trimmed = branding.aiDisclosure.trim()
  return trimmed.length > 0 ? trimmed : null
}

const unwrap = <T,>(payload: any): T => (payload?.data ?? payload) as T

/**
 * A branding payload we can actually render.
 *
 * Without this, a response that is not branding at all (an HTML error
 * page, a proxy 404, a misrouted request) flows through as an object,
 * the query resolves "successfully", and the first component to touch
 * a missing field white-screens the whole app. A failed request should
 * land on the error state, not on a blank page.
 */
function assertBranding(value: any): HostedChatBranding {
  if (!value || typeof value.appName !== 'string' || !value.appName) {
    throw new Error('Malformed branding response')
  }
  return {
    ...value,
    primaryColor: typeof value.primaryColor === 'string' ? value.primaryColor : '#8b5cf6',
    greeting: typeof value.greeting === 'string' ? value.greeting : '',
    suggestedPrompts: Array.isArray(value.suggestedPrompts) ? value.suggestedPrompts : [],
    whiteLabel: value.whiteLabel === true,
  }
}

export const hostedChatApi = {
  branding: (slug: string) =>
    client()
      .get(`/public/chat/${slug}`)
      .then((r) => assertBranding(unwrap<HostedChatBranding>(r.data))),

  conversations: (slug: string) =>
    client()
      .get(`/public/chat/${slug}/conversations`)
      .then((r) => unwrap<HostedChatConversation[]>(r.data)),

  messages: (slug: string, conversationId: string) =>
    client()
      .get(`/public/chat/${slug}/conversations/${conversationId}/messages`)
      .then((r) =>
        unwrap<{ conversationId: string; title: string; messages: HostedChatMessage[] }>(r.data),
      ),

  send: (slug: string, message: string, conversationId?: string) =>
    client()
      .post(`/public/chat/${slug}/messages`, { message, conversationId })
      .then((r) => unwrap<{ runId: string; conversationId: string }>(r.data)),

  /** Who the visitor is and whether the surface admits them (issues the cookie). */
  me: (slug: string) =>
    client()
      .get(`/public/chat/${slug}/me`)
      .then((r) =>
        unwrap<{
          authMode: HostedChatBranding['authMode']
          available: boolean
          authenticated: boolean
          email: string | null
          displayName: string | null
        }>(r.data),
      ),

  /** Full-page redirect target that starts the tenant's SSO sign-in. */
  ssoLoginUrl: (slug: string) => `${HOSTED_CHAT_API_PREFIX}/public/chat/${slug}/auth/sso/login`,

  /** SSE endpoint for an in-flight reply. Same origin, see above. */

  streamUrl: (slug: string, runId: string) =>
    `${HOSTED_CHAT_API_PREFIX}/public/chat/${slug}/stream?runId=${encodeURIComponent(runId)}`,
}
