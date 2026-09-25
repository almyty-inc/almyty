/**
 * Settings allows two levels of navigation: the section tabs, then the
 * page links inside a section. A settings page that brings its own row
 * of tabs (Members | Teams used to) makes three, which is one too many
 * for anyone looking for a switch. Pages stack their parts instead.
 *
 * This walks every component a settings page renders, following local
 * imports, and fails if any of them pulls in the Tabs primitive or
 * draws its own tablist.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'

const SRC = join(__dirname, '..', '..')
const SETTINGS_PAGE = join(SRC, 'pages', 'settings.tsx')

function resolveImport(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else return null
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate
  }
  return null
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const specs = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  return specs
    .map((s) => resolveImport(file, s))
    .filter((f): f is string => !!f)
}

const isUiPrimitive = (file: string) => file.includes(join('components', 'ui') + '/')
const TABS_PRIMITIVE = join(SRC, 'components', 'ui', 'tabs.tsx')

/** Every component file reachable from the settings page components, excluding the shell itself. */
function settingsPageFiles(): string[] {
  const roots = importsOf(SETTINGS_PAGE).filter((f) => f.includes(`${join('src', 'components')}/`) && !isUiPrimitive(f))
  const seen = new Set<string>()
  const queue = [...roots]
  while (queue.length) {
    const file = queue.shift()!
    if (seen.has(file) || isUiPrimitive(file) || file.includes('/store/') || file.includes('/lib/')) continue
    seen.add(file)
    queue.push(...importsOf(file))
  }
  return [...seen]
}

describe('settings navigation depth', () => {
  it('finds the settings pages to check', () => {
    const files = settingsPageFiles().map((f) => f.slice(SRC.length + 1))
    expect(files).toEqual(expect.arrayContaining([
      'components/MembersAndTeamsTab.tsx',
      'components/SecurityTab.tsx',
      'components/BillingTab.tsx',
      'components/settings/rbac-settings.tsx',
      'components/settings/sso-settings.tsx',
    ]))
  })

  it('renders no Tabs inside a settings section page', () => {
    const offenders = settingsPageFiles()
      .filter((file) => {
        const source = readFileSync(file, 'utf8')
        return importsOf(file).includes(TABS_PRIMITIVE) || /role=["']tablist["']/.test(source)
      })
      .map((f) => f.slice(SRC.length + 1))
    expect(offenders).toEqual([])
  })

  it('uses Tabs only once in the settings shell, for the sections', () => {
    const shell = readFileSync(SETTINGS_PAGE, 'utf8')
    expect(shell.match(/<TabsList\b/g) ?? []).toHaveLength(1)
  })
})
