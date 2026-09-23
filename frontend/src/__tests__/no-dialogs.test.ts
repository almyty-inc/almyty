import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * No dialogs.
 *
 * The product rule: "dialogs are tedious and terrible for UX". A flow that
 * creates or configures something is a page with its own route, or an
 * inline section of the detail view it belongs to. The one exception is a
 * one-line destructive confirmation ("Delete this gateway?") through the
 * shared useConfirm() / AlertDialog.
 *
 * The WhatsApp distribution dialog was the worked example of why: its
 * primary button was clipped off the bottom, it had two save buttons, it
 * said its own name three times, and it never showed the callback URL
 * Meta's console asks for. Ninety-four Dialog/Sheet/AlertDialog uses
 * existed when the rule was set.
 *
 * These checks read the source, because a dialog that is imported and
 * never opened still compiles, still passes its tests, and is still the
 * shape the next person copies.
 */

const SRC = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const isTest = (f: string) => /(__tests__|\.test\.|\.spec\.|\/test\/)/.test(f)
const sources = walk(SRC)
  .filter((f) => !isTest(f))
  .map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }))

/** The primitives themselves, and the one thing that is a palette, not a form. */
const PRIMITIVES = new Set([
  'components/ui/dialog.tsx',
  'components/ui/sheet.tsx',
  // cmdk's CommandDialog wraps Dialog. The command palette is navigation
  // (type, pick, go), not a create or configure flow, and it is only
  // allowed in command-palette.tsx (checked below).
  'components/ui/command.tsx',
])

/**
 * Areas another workstream is converting at the same time. Each entry is
 * temporary: REMOVE IT when that area lands without dialogs. The
 * "exemptions are still needed" test fails once an entry no longer
 * covers any dialog, so a stale entry cannot linger.
 */
const OTHER_WORKSTREAMS = [
  // Agent configuration (model picker + collaboration).
  'components/agents/',
]

const exempt = (p: string) =>
  PRIMITIVES.has(p) || OTHER_WORKSTREAMS.some((prefix) => p === prefix || p.startsWith(prefix))

/** Names a file imports from the dialog or sheet primitive. */
function dialogImports(text: string): string[] {
  const names: string[] = []
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  for (const m of text.matchAll(re)) {
    const from = m[2]
    if (!/(^|\/)ui\/(dialog|sheet)$|^\.\/(dialog|sheet)$/.test(from)) continue
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0]
      if (name) names.push(name)
    }
  }
  return names
}

describe('no dialogs', () => {
  it('no file outside the exemptions imports Dialog or Sheet', () => {
    const offenders = sources
      .filter(({ path }) => !exempt(path))
      .map(({ path, text }) => ({ path, names: dialogImports(text) }))
      .filter(({ names }) => names.length > 0)
      .map(({ path, names }) => `${path}: ${names.join(', ')}`)
    expect(offenders).toEqual([])
  })

  it('only the command palette opens a CommandDialog', () => {
    const users = sources
      .filter(({ path }) => path !== 'components/ui/command.tsx')
      .filter(({ text }) => /\bCommandDialog\b/.test(text))
      .map(({ path }) => path)
    expect(users).toEqual(['components/command-palette.tsx'])
  })

  it('an AlertDialog only asks a question: no form controls inside it', () => {
    const offenders: string[] = []
    for (const { path, text } of sources) {
      if (exempt(path)) continue
      let from = 0
      for (;;) {
        const start = text.indexOf('<AlertDialogContent', from)
        if (start === -1) break
        const end = text.indexOf('</AlertDialogContent>', start)
        const body = text.slice(start, end === -1 ? undefined : end)
        if (/<(Input|Textarea|Select|SecretInput|form|input|textarea|select)\b/.test(body)) {
          offenders.push(`${path}:${text.slice(0, start).split('\n').length}`)
        }
        from = end === -1 ? text.length : end
      }
    }
    expect(offenders).toEqual([])
  })

  it('no window.prompt: a text answer is a form field on a page', () => {
    const offenders = sources
      .filter(({ path }) => !exempt(path))
      .filter(({ text }) => /\bwindow\.prompt\s*\(/.test(text))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('?new=1 deep links redirect to a create page instead of opening a dialog', () => {
    // useCreateDeepLink opens a local dialog. It survives only for a page
    // in another workstream's area that still has one.
    const users = sources
      .filter(({ text }) => /\buseCreateDeepLink\s*\(/.test(text))
      .map(({ path }) => path)
      .filter((p) => p !== 'hooks/use-create-deep-link.ts')
    expect(users.filter((p) => !exempt(p))).toEqual([])
  })

  it('in-app links go straight to a create page, never through ?new=1', () => {
    // `?new=1` survives only as a redirect for old bookmarks
    // (useNewParamRedirect). A palette entry, onboarding step or button
    // that still links through it bounces via a list page first.
    const offenders: string[] = []
    for (const { path, text } of sources) {
      // The two hooks that handle the parameter describe it in comments.
      if (exempt(path) || path.startsWith('hooks/use-')) continue
      for (const m of text.matchAll(/['"`][^'"`\n]*[?&]new=1[^'"`\n]*['"`]/g)) {
        offenders.push(`${path}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the exemptions are still needed (remove an entry once its area lands)', () => {
    const stale = OTHER_WORKSTREAMS.filter(
      (prefix) =>
        !sources.some(
          ({ path, text }) =>
            (path === prefix || path.startsWith(prefix)) &&
            (dialogImports(text).length > 0 || /\buseCreateDeepLink\s*\(/.test(text)),
        ),
    )
    expect(stale).toEqual([])
  })
})

/**
 * Every dialog that became a page or an inline section. The file must be
 * gone -- a converted dialog left on disk is the "unwired unit" this
 * codebase keeps producing: it compiles, its tests pass, nothing opens it.
 */
const CONVERTED_DIALOGS: string[] = [
  'components/SchemaImportDialog.tsx',
  'components/apis/create-api-dialog.tsx',
  'components/llm-providers/edit-provider-dialog.tsx',
  'components/llm-providers/test-provider-dialog.tsx',
  'components/tools/add-mcp-server-dialog.tsx',
  'components/tools/create-tool-dialog.tsx',
  'components/tools/publish-tool-dialog.tsx',
  'components/tools/tool-execution-dialog.tsx',
  'components/agent-apps/add-distribution-dialog.tsx',
  'components/agent-apps/create-app-dialog.tsx',
  'components/agent-apps/distribution-panel.tsx',
  'components/agent-apps/signing-credential-dialog.tsx',
  'components/gateways/create-gateway-dialog.tsx',
  'components/gateways/detail/edit-gateway-dialog.tsx',
  'components/gateways/gateway-details-sheet.tsx',
]

describe('converted dialogs are deleted', () => {
  it.each(CONVERTED_DIALOGS.length ? CONVERTED_DIALOGS : ['(none yet)'])('%s is gone', (p) => {
    if (p === '(none yet)') return
    expect(existsSync(join(SRC, p))).toBe(false)
  })
})
