import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

/**
 * Source-reading guards for four things that drifted one screen at a
 * time, each of which looked fine in its own file:
 *
 * - window.confirm: an unstyled, page-blocking browser box. Two team
 *   actions used it while every other destructive action had an
 *   AlertDialog. The shared useConfirm() hook is the one way to ask.
 * - A destructive AlertDialogAction styled by pasting the button's
 *   destructive classes, sixteen times over. AlertDialogAction takes
 *   variant="destructive" now; a pasted copy drifts the day the button
 *   variant changes.
 * - Confirmations hand-assembled from the AlertDialog parts, each with its
 *   own title case, button label and colour. useConfirm() is the one shape;
 *   only the primitive files import alert-dialog directly.
 * - GraphQL was pink on API badges and rose on protocol badges. The brand
 *   says rose.
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

const isTest = (f: string) => /(__tests__|\.test\.|\.spec\.)/.test(f)
const sources = walk(SRC)
  .filter((f) => !isTest(f))
  .map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }))

const DESTRUCTIVE_PASTE = 'bg-destructive text-destructive-foreground hover:bg-destructive/90'

/**
 * Files another change owns and has not converted yet. Each entry must
 * still contain the paste -- once it is fixed there, drop it from here so
 * the guard covers it again.
 */
const PASTE_PENDING_ELSEWHERE = new Set<string>([])

/** Every `<AlertDialogAction ...>...</AlertDialogAction>` element in a file. */
function alertDialogActions(text: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const start = text.indexOf('<AlertDialogAction', from)
    if (start === -1) return out
    const end = text.indexOf('</AlertDialogAction>', start)
    out.push(text.slice(start, end === -1 ? start + 800 : end))
    from = start + 1
  }
}

/** The primitive itself, and the hook built on it. */
const ALERT_DIALOG_PRIMITIVES = new Set<string>([
  'components/ui/alert-dialog.tsx',
  'components/ui/confirm-dialog.tsx',
])

/**
 * Files that still build their confirmation from the AlertDialog parts
 * directly. Each one converts to useConfirm(); drop the entry as it does,
 * so the guard covers the file from then on. Nothing new goes on here.
 */
const ALERT_DIALOG_PENDING = new Set<string>([
  'components/agents/detail/overview-tab.tsx',
  'components/analytics/budgets-tab.tsx',
  'components/apis/detail/credentials-tab.tsx',
  'components/connections-governance/policies-table.tsx',
  'components/connections-governance/review-dashboard.tsx',
  'components/connections/connection-detail.tsx',
  'components/connections/grants-editor.tsx',
  'components/models/hosting/hosting-panel.tsx',
  'components/models/models-catalog.tsx',
  'components/settings/approval-policies-settings.tsx',
  'components/settings/rbac-settings.tsx',
  'components/tools/mcp-sources-panel.tsx',
  'pages/agents.tsx',
  'pages/apis.tsx',
  'pages/hosted-chat.tsx',
  'pages/memories.tsx',
  'pages/model-detail.tsx',
  'pages/tool-hub.tsx',
  'pages/tools.tsx',
  'pages/workspace-detail.tsx',
])

const importsAlertDialog = (text: string) =>
  /from\s+['"][^'"]*\/alert-dialog['"]/.test(text)

describe('confirmations', () => {
  it('never asks through window.confirm', () => {
    const offenders = sources
      .filter(({ text }) => /\bwindow\.confirm\s*\(/.test(text))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('never calls the global confirm() bare', () => {
    // A bare confirm( is the browser global unless the file took
    // `confirm` from useConfirm(), whose confirm() is awaited.
    const offenders = sources
      .filter(({ text }) => !/\buseConfirm\s*\(/.test(text))
      .filter(({ text }) => /(^|[^\w.$])confirm\s*\(/m.test(text))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('styles destructive AlertDialogActions with variant, not pasted classes', () => {
    const offenders = sources
      .filter(({ path }) => !PASTE_PENDING_ELSEWHERE.has(path))
      .filter(({ text }) => alertDialogActions(text).some((el) => el.includes(DESTRUCTIVE_PASTE)))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('keeps the pending list honest', () => {
    const byPath = new Map(sources.map((s) => [s.path, s.text]))
    for (const path of PASTE_PENDING_ELSEWHERE) {
      const text = byPath.get(path)
      expect(text, `${path} no longer exists; remove it from the list`).toBeDefined()
      expect(
        alertDialogActions(text!).some((el) => el.includes(DESTRUCTIVE_PASTE)),
        `${path} is converted; remove it from PASTE_PENDING_ELSEWHERE`,
      ).toBe(true)
    }
  })

  it('asks through useConfirm() instead of a hand-built AlertDialog', () => {
    const offenders = sources
      .filter(({ path }) => !ALERT_DIALOG_PRIMITIVES.has(path))
      .filter(({ path }) => !ALERT_DIALOG_PENDING.has(path))
      .filter(({ text }) => importsAlertDialog(text))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('keeps the AlertDialog pending list honest', () => {
    const byPath = new Map(sources.map((s) => [s.path, s.text]))
    for (const path of ALERT_DIALOG_PENDING) {
      const text = byPath.get(path)
      expect(text, `${path} no longer exists; remove it from ALERT_DIALOG_PENDING`).toBeDefined()
      expect(
        importsAlertDialog(text!),
        `${path} no longer imports alert-dialog; remove it from ALERT_DIALOG_PENDING`,
      ).toBe(true)
    }
  })
})

describe('protocol badge colours', () => {
  const colourOf = (file: string, key: string) => {
    const text = readFileSync(join(SRC, file), 'utf8')
    const match = text.match(new RegExp(`\\b${key}:\\s*'([^']+)'`))
    expect(match, `${file} has no ${key} style`).not.toBeNull()
    const hues = [...match![1].matchAll(/\b(?:bg|text|border)-([a-z]+)-\d{2,3}\b/g)].map((m) => m[1])
    return new Set(hues)
  }

  it.each(['components/ui/api-type-badge.tsx', 'components/ui/protocol-badge.tsx'])(
    'maps GraphQL to rose in %s',
    (file) => {
      expect([...colourOf(file, 'graphql')]).toEqual(['rose'])
    },
  )
})
