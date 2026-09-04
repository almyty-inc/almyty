import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, MessageSquarePlus, Menu, X } from 'lucide-react'
import type { Components } from 'react-markdown'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { cn } from '@/lib/utils'
import {
  disclosureLine,
  hostedChatApi,
  type HostedChatBranding,
  type HostedChatMessage,
} from '@/lib/hosted-chat'

const ReactMarkdown = lazy(() => import('react-markdown'))

/**
 * A tenant's own chat app, served at {slug}.<base domain>.
 *
 * Neutral by default: the tenant's colour and logo carry the page, and
 * almyty appears only as a small mark that the white-label entitlement
 * removes. It should read as their product, not as a page of ours with
 * their logo dropped in, which is why it borrows the design tokens but
 * none of the dashboard chrome.
 */

interface HostedChatPageProps {
  slug: string
}

interface PendingMessage extends HostedChatMessage {
  streaming?: boolean
}

/** Contrasting foreground for an arbitrary tenant colour. */
function readableOn(hex: string): string {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  // Rec. 709 luma: a tenant picking a pale brand colour still gets
  // readable text rather than white-on-yellow.
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luma > 0.6 ? '#18181b' : '#ffffff'
}

/**
 * What a visitor sees on a surface that requires sign-in, before they
 * have. Carries the tenant's name and colour so it reads as their door,
 * not ours. Only SSO has a flow behind it today; the other modes say so
 * rather than pretending.
 */
function SignInScreen({
  slug,
  branding,
  available,
  style,
}: {
  slug: string
  branding: HostedChatBranding
  available: boolean
  style: React.CSSProperties
}) {
  const sso = branding.authMode === 'sso'
  return (
    <div style={style} className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-8 text-center shadow-sm">
        {branding.logoUrl ? (
          <img src={branding.logoUrl} alt="" className="mx-auto mb-4 h-12 w-12 rounded-lg object-cover" />
        ) : (
          <div
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg text-lg font-semibold"
            style={{ backgroundColor: 'var(--tenant)', color: 'var(--on-tenant)' }}
          >
            {branding.appName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <h1 className="font-heading text-xl font-semibold">Sign in to {branding.appName}</h1>
        {!available ? (
          <p className="mt-2 text-sm text-muted-foreground">
            This chat is not accepting sign-ins right now. Please contact {branding.appName}.
          </p>
        ) : sso ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">Use your organization account to continue.</p>
            <a
              href={hostedChatApi.ssoLoginUrl(slug)}
              className="mt-6 inline-flex w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium"
              style={{ backgroundColor: 'var(--tenant)', color: 'var(--on-tenant)' }}
            >
              Continue with single sign-on
            </a>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            This chat requires a sign-in method that is not set up yet. Please contact {branding.appName}.
          </p>
        )}
        {!branding.whiteLabel && (
          <p className="mt-6 text-xs text-muted-foreground">Powered by almyty</p>
        )}
      </div>
    </div>
  )
}

export function HostedChatPage({ slug }: HostedChatPageProps) {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<PendingMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const streamRef = useRef<EventSource | null>(null)

  const {
    data: branding,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['hosted-chat-branding', slug],
    queryFn: () => hostedChatApi.branding(slug),
    retry: false,
  })

  // A surface that requires sign-in admits nobody until the backend says
  // this visitor is signed in the required way. Public surfaces skip the
  // round trip entirely.
  const requiresAuth = !!branding && branding.authMode !== 'public_link'
  const {
    data: me,
    isLoading: meLoading,
    refetch: refetchMe,
  } = useQuery({
    queryKey: ['hosted-chat-me', slug],
    queryFn: () => hostedChatApi.me(slug),
    enabled: requiresAuth,
    retry: false,
  })
  const admitted = !!branding && (!requiresAuth || me?.authenticated === true)

  const { data: conversations, refetch: refetchConversations } = useQuery({
    queryKey: ['hosted-chat-conversations', slug],
    queryFn: () => hostedChatApi.conversations(slug),
    enabled: admitted,
  })

  const accent = branding?.primaryColor ?? '#8b5cf6'
  const onAccent = useMemo(() => readableOn(accent), [accent])

  // The tenant picks one colour; everything else derives from it so a
  // brand colour cannot produce an unreadable page.
  const style = useMemo(
    () => ({ '--tenant': accent, '--on-tenant': onAccent }) as React.CSSProperties,
    [accent, onAccent],
  )

  useEffect(() => {
    if (branding?.appName) document.title = branding.appName
  }, [branding?.appName])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Close any open stream when the page goes away, so a navigation does
  // not leave an EventSource retrying forever in the background.
  useEffect(() => () => streamRef.current?.close(), [])

  const openConversation = useCallback(
    async (id: string) => {
      setSidebarOpen(false)
      setConversationId(id)
      const thread = await hostedChatApi.messages(slug, id)
      setMessages(thread.messages)
    },
    [slug],
  )

  const startNew = useCallback(() => {
    streamRef.current?.close()
    setConversationId(null)
    setMessages([])
    setError(null)
    setSidebarOpen(false)
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return

    setError(null)
    setDraft('')
    setSending(true)
    setMessages((current) => [
      ...current,
      {
        id: `local-${current.length}`,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      },
    ])

    try {
      const { runId, conversationId: threadId } = await hostedChatApi.send(
        slug,
        text,
        conversationId ?? undefined,
      )
      setConversationId(threadId)

      // Placeholder the reply streams into, so the page shows progress
      // rather than a frozen input.
      setMessages((current) => [
        ...current,
        {
          id: `run-${runId}`,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          streaming: true,
        },
      ])

      streamRef.current?.close()
      const source = new EventSource(hostedChatApi.streamUrl(slug, runId), {
        withCredentials: true,
      })
      streamRef.current = source

      source.addEventListener('token', (event) => {
        const payload = JSON.parse((event as MessageEvent).data || '{}')
        const chunk = payload.token ?? payload.text ?? payload.content ?? ''
        if (!chunk) return
        setMessages((current) =>
          current.map((m) => (m.id === `run-${runId}` ? { ...m, content: m.content + chunk } : m)),
        )
      })

      // Both the done event and onerror route here, and a closed
      // EventSource can still fire onerror after done; reconcile once.
      let finished = false
      const finish = async (reason?: string) => {
        if (finished) return
        finished = true
        source.close()
        setSending(false)
        // The stream carries progress; the transcript is the source of
        // truth, so reconcile once rather than trusting accumulated
        // chunks (a reconnect or a non-streaming run would otherwise
        // leave the reply empty).
        let thread: Awaited<ReturnType<typeof hostedChatApi.messages>>
        try {
          thread = await hostedChatApi.messages(slug, threadId)
        } catch {
          // Transcript fetch failed too: keep the visitor's turn, drop the
          // empty placeholder, and say so rather than hanging silently.
          setMessages((current) => current.filter((m) => !m.streaming))
          setError("The assistant couldn't reply just now. Please try again in a moment.")
          return
        }
        setMessages(thread.messages)
        refetchConversations()
        // A run that failed (provider outage, quota, tool error) leaves the
        // transcript ending on the visitor's turn. Without saying so the
        // page just goes quiet, which reads as "ignored".
        const last = thread.messages[thread.messages.length - 1]
        const unanswered = !last || last.role === 'user'
        if (reason === 'run.cancelled') {
          setError('That reply was cancelled. Please try again.')
        } else if (reason === 'run.failed' || unanswered) {
          setError("The assistant couldn't reply just now. Please try again in a moment.")
        }
      }

      source.addEventListener('done', (event) => {
        let reason: string | undefined
        try {
          reason = JSON.parse((event as MessageEvent).data || '{}').reason
        } catch {
          /* malformed payload: fall through to the transcript check */
        }
        void finish(reason)
      })
      source.onerror = () => {
        void finish()
      }
    } catch (err: any) {
      setSending(false)
      const status = err?.response?.status
      // Signed out (or never signed in) on a surface that requires it:
      // re-ask the backend and the page flips to the sign-in screen.
      if (status === 401) void refetchMe()
      setError(
        status === 429
          ? 'This assistant is busy right now. Please try again in a moment.'
          : err?.response?.data?.message || 'Something went wrong. Please try again.',
      )
      // Drop the optimistic user turn: leaving it implies it was sent.
      setMessages((current) => current.filter((m) => !m.id.startsWith('local-')))
    }
  }, [conversationId, draft, refetchConversations, sending, slug])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <LoadingSpinner />
      </div>
    )
  }

  if (isError || !branding) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="text-center">
          <h1 className="font-heading text-2xl font-semibold">This chat is not available</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The link may be wrong, or the assistant may have been turned off.
          </p>
        </div>
      </div>
    )
  }

  if (requiresAuth && !admitted) {
    if (meLoading) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <LoadingSpinner />
        </div>
      )
    }
    return <SignInScreen slug={slug} branding={branding} available={me?.available !== false} style={style} />
  }

  const disclosure = disclosureLine(branding)
  const showEmpty = messages.length === 0
  const hasHistory = (conversations?.length ?? 0) > 0

  return (
    <div style={style} className="flex min-h-screen bg-background text-foreground">
      {/* A first-time visitor has no history, so a permanent rail would
          be 300px of empty white next to the thing they came for. It
          appears once there is something in it. */}
      {hasHistory && (
        <Sidebar
          open={sidebarOpen}
          branding={branding}
          conversations={conversations ?? []}
          activeId={conversationId}
          onOpen={openConversation}
          onNew={startNew}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          {hasHistory && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Conversations"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
          )}
          <BrandMark branding={branding} />
        </header>

        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
          {showEmpty ? (
            <EmptyState
              branding={branding}
              onPick={(prompt) => {
                setDraft(prompt)
              }}
            />
          ) : (
            <div className="flex-1 space-y-6 py-6">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
              <div ref={bottomRef} />
            </div>
          )}

          {error && (
            <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="sticky bottom-0 bg-background pb-4 pt-2">
            <div className="flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-[var(--tenant)]">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={1}
                aria-label="Message"
                placeholder={`Message ${branding.appName}`}
                className="max-h-40 min-h-[2.5rem] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
              <Button
                type="button"
                size="icon"
                aria-label="Send"
                disabled={!draft.trim() || sending}
                onClick={() => void send()}
                className="h-9 w-9 shrink-0 rounded-xl"
                style={{ background: 'var(--tenant)', color: 'var(--on-tenant)' }}
              >
                {sending ? <LoadingSpinner className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
              </Button>
            </div>

            {/* EU AI Act Art. 50: present unless the tenant holds the
                white-label entitlement and cleared it. */}
            {disclosure && (
              <p className="mt-2 text-center text-xs text-muted-foreground">{disclosure}</p>
            )}
            {!branding.whiteLabel && (
              <p className="mt-1 text-center text-[11px] text-muted-foreground/70">
                Powered by{' '}
                <a href="https://almyty.com" className="underline underline-offset-2">
                  almyty
                </a>
              </p>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

function BrandMark({ branding }: { branding: HostedChatBranding }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {branding.logoUrl ? (
        <img src={branding.logoUrl} alt="" className="h-7 w-7 rounded-md object-contain" />
      ) : (
        <span
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-md text-sm font-semibold"
          style={{ background: 'var(--tenant)', color: 'var(--on-tenant)' }}
        >
          {(branding.appName || '?').charAt(0).toUpperCase()}
        </span>
      )}
      <span className="truncate font-heading text-sm font-semibold">
        {branding.appName || 'Assistant'}
      </span>
    </div>
  )
}

function EmptyState({
  branding,
  onPick,
}: {
  branding: HostedChatBranding
  onPick: (prompt: string) => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-end pb-8 text-center">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        {branding.greeting || `How can I help?`}
      </h1>
      {branding.suggestedPrompts.length > 0 && (
        // auto-fit rather than a fixed column count: three prompts
        // centre as a row instead of wrapping to 2 + an orphan.
        <div className="mt-8 grid w-full max-w-2xl justify-center gap-2 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          {branding.suggestedPrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onPick(prompt)}
              className="rounded-xl border bg-card px-4 py-3 text-left text-sm transition-colors hover:border-[var(--tenant)] hover:bg-[color-mix(in_srgb,var(--tenant)_6%,transparent)]"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MessageBubble({ message }: { message: PendingMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
          isUser ? 'whitespace-pre-wrap' : 'bg-muted',
        )}
        style={isUser ? { background: 'var(--tenant)', color: 'var(--on-tenant)' } : undefined}
      >
        {message.content ? (
          isUser ? (
            message.content
          ) : (
            <Suspense fallback={<span className="whitespace-pre-wrap">{message.content}</span>}>
              <ReactMarkdown skipHtml components={assistantMarkdownComponents}>
                {message.content}
              </ReactMarkdown>
            </Suspense>
          )
        ) : message.streaming ? (
          <StreamingDots />
        ) : null}
      </div>
    </div>
  )
}

const assistantMarkdownComponents: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-background/70 px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-lg bg-background/70 p-3 last:mb-0">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-current/30 pl-3 last:mb-0">{children}</blockquote>
  ),
}

function StreamingDots() {
  return (
    <span className="inline-flex gap-1 py-1" aria-label="Thinking">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-60"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  )
}

function Sidebar({
  open,
  branding,
  conversations,
  activeId,
  onOpen,
  onNew,
  onClose,
}: {
  open: boolean
  branding: HostedChatBranding
  conversations: Array<{ id: string; title: string }>
  activeId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onClose: () => void
}) {
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-40 w-72 border-r bg-card p-3 transition-transform md:static md:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex items-center justify-between md:hidden">
        <BrandMark branding={branding} />
        <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      <Button
        type="button"
        variant="outline"
        className="mt-3 w-full justify-start gap-2 md:mt-0"
        onClick={onNew}
      >
        <MessageSquarePlus className="h-4 w-4" />
        New chat
      </Button>

      <nav className="mt-4 space-y-1 overflow-y-auto" aria-label="Conversations">
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            onClick={() => onOpen(conversation.id)}
            aria-current={conversation.id === activeId ? 'true' : undefined}
            className={cn(
              'w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors',
              conversation.id === activeId ? 'bg-muted font-medium' : 'hover:bg-muted/60',
            )}
          >
            {conversation.title}
          </button>
        ))}
      </nav>
    </aside>
  )
}
