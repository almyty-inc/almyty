import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Apps are the one place an agent is put in front of people, and they
 * say so in the shared pieces rather than in a look of their own.
 *
 * These read the source, because a copied card still renders, still
 * passes its own tests, and is the shape the next person copies.
 */
const SRC = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** The files this surface is made of. */
const FILES = [
  'components/agent-apps/web-place.tsx',
  'components/agent-apps/app-access.tsx',
  'components/agent-apps/slack-install.tsx',
  'components/agent-apps/distribution-settings.tsx',
  'components/agent-apps/app-settings-panel.tsx',
  'components/agent-apps/add-distribution-picker.tsx',
  'components/agent-apps/app-page-loader.tsx',
  'components/agents/detail/interfaces-tab.tsx',
  'components/gateways/managed-by-app-banner.tsx',
  'components/gateways/visitor-oauth-card.tsx',
  'components/ui/choice-tile.tsx',
  'pages/app-detail.tsx',
]

/** Words a person reads: JSX text and string literals, minus imports and comments. */
function readableStrings(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^import[\s\S]*?from '[^']*'/gm, '')
  const out: string[] = []
  for (const m of code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  for (const m of code.matchAll(/(?<![=-])>([^<>{}()=;]+)</g)) out.push(m[1])
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Labels: section and card titles, buttons, tabs, field labels, headings, empty states. */
function labels(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/\btitle(?:=|:\s*)["']([^"'\n{}]+)["']/g)) out.push(m[1])
  for (const m of source.matchAll(/\blabel(?:=|:\s*)["']([^"'\n{}]+)["']/g)) out.push(m[1])
  // Attributes may hold arrow functions, so `=>` does not end the tag.
  for (const m of source.matchAll(/<(Button|TabsTrigger|CardTitle|Label|h[1-4])\b(?:=>|[^>])*>\s*([^<{]+?)\s*<\//g)) out.push(m[2])
  // A link's words, also inside a Button asChild, after any icon.
  for (const m of source.matchAll(/<Link\b(?:=>|[^>])*>(?:\s*<[A-Z]\w*\b[^>]*\/>)?\s*([^<{]+?)\s*</g)) out.push(m[1])
  return out.map((s) => s.trim()).filter((s) => /[A-Za-z]/.test(s))
}

/** Capitalised past the first word only for names and acronyms. */
const PROPER = new Set([
  'Slack', 'Google', 'Microsoft', 'GitHub', 'Discord', 'Telegram', 'WhatsApp', 'Meta', 'Twilio', 'Teams', 'Chat',
  'Signal', 'Matrix', 'IRC', 'SMS', 'OAuth', 'OpenID', 'Connect', 'SSO', 'AI', 'EU', 'URL', 'URI', 'ID', 'JWKS',
  'IP', 'JSON', 'Entra', 'Web', 'Art.', 'Act', 'Advanced', 'Where',
])

function titleCaseWords(label: string): string[] {
  return label
    .split(/\s+/)
    .slice(1)
    .filter((w) => /^[A-Z][a-z]/.test(w) && !PROPER.has(w.replace(/[^A-Za-z.]/g, '')))
}

describe('apps are the one place, in the shared look', () => {
  it('the web app page reuses the gateway cards rather than copies of them', () => {
    const web = read('components/agent-apps/web-place.tsx')
    for (const card of ['custom-domain-card', 'allowed-origins-card', 'visitor-oauth-card', 'hosted-chat-sso-urls']) {
      expect(web).toMatch(new RegExp(`from '@/components/gateways/${card}'`))
    }
    expect(read('components/agent-apps/app-access.tsx')).toMatch(/from '@\/components\/llm-providers\/who-can-use'/)
  })

  it('no file here builds its own domain, allowed sites or sign-in card', () => {
    for (const rel of FILES.filter((f) => f.startsWith('components/agent-apps') || f.startsWith('pages/'))) {
      const src = read(rel)
      expect(src, rel).not.toMatch(/>\s*(Custom domain|Allowed sites|Visitor sign-in provider)\s*</)
      expect(src, rel).not.toMatch(/(setCustomDomain|setVisitorOAuth|allowedOrigins:)/)
    }
  })

  it('the Advanced fold and the tiles are the shared ones', () => {
    for (const rel of ['components/agent-apps/app-settings-panel.tsx', 'components/agent-apps/distribution-settings.tsx', 'components/gateways/visitor-oauth-card.tsx']) {
      expect(read(rel), rel).toMatch(/from '@\/components\/ui\/disclosure'/)
    }
    for (const rel of ['components/agent-apps/app-access.tsx', 'components/gateways/visitor-oauth-card.tsx']) {
      expect(read(rel), rel).toMatch(/from '@\/components\/ui\/choice-tile'/)
    }
    // One grid, in the Models tile look.
    expect(read('components/ui/choice-tile.tsx')).toContain(
      'flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors',
    )
    expect(read('pages/models-connect.tsx')).toContain(
      'flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors',
    )
  })

  it('opens no dialog: pages and inline sections only, confirms through useConfirm', () => {
    for (const rel of FILES) {
      const src = read(rel)
      expect(src, rel).not.toMatch(/from '@\/components\/ui\/(dialog|sheet)'/)
      expect(src, rel).not.toMatch(/<(Dialog|Sheet|AlertDialog)\b/)
      expect(src, rel).not.toMatch(/window\.(prompt|confirm)\s*\(/)
    }
  })

  it('says "where people use it", never "distribution", to a person', () => {
    for (const rel of FILES) {
      const offenders = readableStrings(read(rel)).filter(
        // Paths, query keys and ids are not prose.
        (s) => /\bdistributions?\b/i.test(s) && /\s/.test(s) && !s.startsWith('/'),
      )
      expect(offenders, rel).toEqual([])
    }
  })

  it('writes labels in sentence case and almyty in lowercase', () => {
    for (const rel of FILES) {
      const src = read(rel)
      const offenders = labels(src).filter((l) => titleCaseWords(l).length > 0)
      expect(offenders, rel).toEqual([])
      expect(readableStrings(src).filter((s) => /\bAlmyty\b/.test(s)), rel).toEqual([])
    }
  })
})
