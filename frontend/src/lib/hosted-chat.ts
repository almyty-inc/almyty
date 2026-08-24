import axios from 'axios'

import { getApiBaseUrl } from './api'

/**
 * Client for the public hosted chat app served at {slug}.<base domain>.
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
function client() {
  if (!instance) {
    instance = axios.create({
      baseURL: getApiBaseUrl(),
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

export const hostedChatApi = {
  branding: (slug: string) =>
    client().get(`/public/chat/${slug}`).then((r) => unwrap<HostedChatBranding>(r.data)),

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

  /** SSE endpoint for an in-flight reply. */
  streamUrl: (slug: string, runId: string) =>
    `${getApiBaseUrl()}/public/chat/${slug}/stream?runId=${encodeURIComponent(runId)}`,
}
