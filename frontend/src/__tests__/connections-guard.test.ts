import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * Connections is one page in the sidebar, built from the same pieces as
 * Models, in plain words. These read the source, so a parallel look-alike,
 * a revived Credentials page or backend words in the connect flow fail
 * here rather than in a product review.
 */
const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__') continue
      out.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

/** Every import name a file takes from a module path. */
function importsFrom(source: string, from: string): string[] {
  const names: string[] = []
  const re = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g
  for (const m of source.matchAll(re)) {
    if (m[2] !== from) continue
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]
      if (name) names.push(name)
    }
  }
  return names
}

describe('Connections and Models are built from the same pieces', () => {
  const modelsConnect = read('pages/models-connect.tsx')
  const servicesConnect = read('pages/connections-connect.tsx')
  const modelsList = read('pages/models.tsx')
  const connectionsList = read('pages/connections.tsx')
  const providerForm = read('components/llm-providers/connect-provider-form.tsx')
  const serviceForm = read('components/connections/connect-flow.tsx')

  it('both connect pages use the shared tile grid and picked-tile card', () => {
    for (const source of [modelsConnect, servicesConnect]) {
      expect(importsFrom(source, '@/components/connect/service-tiles')).toEqual(expect.arrayContaining(['ServiceTileGrid', 'PickedService']))
    }
  })

  it('both lists use the shared connected cards', () => {
    for (const source of [modelsList, connectionsList]) {
      expect(importsFrom(source, '@/components/connect/connected-card')).toEqual(expect.arrayContaining(['ConnectedCard', 'ConnectedCardGrid']))
    }
  })

  it('both forms ask "who can use it" with the same one-liner', () => {
    for (const source of [providerForm, serviceForm]) {
      expect(importsFrom(source, '@/components/connect/who-can-use')).toContain('WhoCanUse')
    }
  })

  it('both say whether it works with the same status label', () => {
    expect(importsFrom(read('components/llm-providers/provider-status.tsx'), '@/components/connect/status-label')).toContain('StatusLabel')
    expect(importsFrom(connectionsList, '@/components/connect/status-label')).toContain('StatusLabel')
  })

  it('nothing else renders a tile grid of its own', () => {
    // The tile markup lives in service-tiles.tsx; a copy elsewhere is the
    // parallel look-alike this guard exists to stop.
    const tileClass = 'grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4'
    const copies = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join('connect', 'service-tiles.tsx')))
      .filter((f) => readFileSync(f, 'utf8').includes(tileClass))
      .map((f) => relative(SRC, f))
    expect(copies).toEqual([])
  })
})

describe('one Connections page', () => {
  it('sits in the sidebar where Credentials was, in the agreed order', () => {
    const layout = read('components/layout/dashboard-layout.tsx')
    const names = [...layout.matchAll(/\{ name: '([^']+)', href: '([^']*)'/g)].map((m) => m[1]).filter((n) => n !== 'divider')
    const order = ['Dashboard', 'APIs', 'Tools', 'Gateways', 'Agents', 'Runners', 'Connections', 'Models', 'Memory', 'Analytics', 'Settings']
    const positions = order.map((n) => names.indexOf(n))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(names).not.toContain('Credentials')
  })

  it('Settings has no Connections tab of its own', () => {
    const settings = read('pages/settings.tsx')
    expect(settings).not.toMatch(/'connections'/)
    expect(settings).not.toMatch(/ConnectionsTab/)
  })

  it.each([
    'pages/credentials.tsx',
    'pages/credential-new.tsx',
    'components/credentials/create-credential-form.tsx',
    'components/credentials/generate-access-key-form.tsx',
    'components/credentials/schema.ts',
    'components/connections/connections-tab.tsx',
    'components/connections/connect-sheet.tsx',
  ])('%s stays deleted', (rel) => {
    expect(existsSync(join(SRC, rel))).toBe(false)
  })

  it('nothing links to the old addresses, which only redirect', () => {
    const OLD = /['"`]\/(credentials|settings\/connections)(\/|['"`?])/
    const hits = sourceFiles(SRC)
      .filter((f) => !f.endsWith('App.tsx') && !f.endsWith(join('pages', 'connection-pages.tsx')))
      .filter((f) => OLD.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))
      .map((f) => relative(SRC, f))
    expect(hits).toEqual([])
  })
})

/** Words a person reads: JSX text and string literals, minus imports and comments. */
function readableStrings(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^import[\s\S]*?from '[^']*'/gm, '')
  const out: string[] = []
  for (const m of code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  for (const m of code.matchAll(/(?<![=-])>([^<>{}()=;]+)</g)) out.push(m[1])
  return out
    .map((s) => s.replace(/\$\{[^}]*\}/g, '').trim())
    .filter((s) => /\s/.test(s) || /^[A-Z]/.test(s))
    // A type annotation read between generics' angle brackets is code, not copy.
    .filter((s) => !/\?:|\s\|\s|=>/.test(s))
}

/** What connecting a service never says. The Advanced tab may; it is for admins. */
const JARGON = /\bvault\b|\bconnectors?\b|\bcredentials?\b|\bgrants?\b|\bOAuth\b|\bvalidat|\bowner\b|\brotat/i

export function jargon(source: string): string[] {
  return readableStrings(source).filter((s) => JARGON.test(s))
}

describe('connecting a service speaks plainly', () => {
  const USER_FACING = [
    'pages/connections.tsx',
    'pages/connections-connect.tsx',
    'components/connections/connect-flow.tsx',
    'components/connections/connection-detail.tsx',
    'components/connections/connection-status.ts',
    'components/connect/service-tiles.tsx',
    'components/connect/connected-card.tsx',
    'components/connect/who-can-use.tsx',
    'components/connect/status-label.tsx',
    'components/credential-picker.tsx',
    'components/access-keys/access-keys-section.tsx',
  ]

  it.each(USER_FACING)('%s', (rel) => {
    expect(jargon(read(rel))).toEqual([])
  })

  it('catches the words it is meant to catch', () => {
    for (const old of [`<p>Select a secret from vault...</p>`, `<Label>Owner</Label>`, `<p>Validation failed</p>`, `const s = 'Rotate OpenAI'`, `<h2>Add custom connector</h2>`]) {
      expect(jargon(old), old).not.toEqual([])
    }
    expect(jargon(`<Button>Connect a service</Button>`)).toEqual([])
  })
})
