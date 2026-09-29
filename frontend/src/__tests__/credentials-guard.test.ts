import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * Credentials is one page in the sidebar, a table like every other list,
 * built from the same pieces as Models, in plain words. Wherever a key is
 * used it is picked or created with the one pick-or-create control, and
 * lands on Credentials. These read the source, so a revived Connections
 * page, a second picker or backend words in the add flow fail here rather
 * than in a product review.
 */
const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'test') continue
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

describe('Credentials and Models are built from the same pieces', () => {
  const modelsConnect = read('pages/models-connect.tsx')
  const addCredential = read('pages/credential-new.tsx')
  const credentialsList = read('pages/credentials.tsx')
  const providerForm = read('components/llm-providers/connect-provider-form.tsx')
  const serviceForm = read('components/connections/connect-flow.tsx')

  it('both add pages use the shared tile grid and picked-tile card', () => {
    for (const source of [modelsConnect, addCredential]) {
      expect(importsFrom(source, '@/components/connect/service-tiles')).toEqual(expect.arrayContaining(['ServiceTileGrid', 'PickedService']))
    }
  })

  it('lists credentials in the shared table, not cards', () => {
    expect(importsFrom(credentialsList, '@/components/ui/data-table')).toContain('DataTable')
    expect(importsFrom(credentialsList, '@/components/connect/connected-card')).toEqual([])
  })

  it('both forms ask "who can use it" with the same one-liner', () => {
    for (const source of [providerForm, serviceForm]) {
      expect(importsFrom(source, '@/components/connect/who-can-use')).toContain('WhoCanUse')
    }
  })

  it('both say whether it works with the same status label', () => {
    expect(importsFrom(read('components/llm-providers/provider-status.tsx'), '@/components/connect/status-label')).toContain('StatusLabel')
    expect(importsFrom(credentialsList, '@/components/connect/status-label')).toContain('StatusLabel')
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

describe('one Credentials page', () => {
  it('sits in the sidebar in the agreed order, with no Connections or Workspaces entry', () => {
    const layout = read('components/layout/dashboard-layout.tsx')
    const names = [...layout.matchAll(/\{ name: '([^']+)', href: '([^']*)'/g)].map((m) => m[1]).filter((n) => n !== 'divider')
    const order = ['Dashboard', 'APIs', 'Tools', 'Gateways', 'Agents', 'Runners', 'Credentials', 'Models', 'Memory', 'Analytics', 'Settings']
    const positions = order.map((n) => names.indexOf(n))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(names).not.toContain('Connections')
    expect(names).not.toContain('Workspaces')
    expect(layout).toMatch(/\{ name: 'Credentials', href: '\/credentials'/)
  })

  it('Settings has no Connections tab of its own', () => {
    const settings = read('pages/settings.tsx')
    expect(settings).not.toMatch(/'connections'/)
    expect(settings).not.toMatch(/ConnectionsTab/)
  })

  it.each([
    'pages/connections.tsx',
    'pages/connections-connect.tsx',
    'pages/connection-pages.tsx',
    'components/connections/connection-detail.tsx',
    'components/credential-picker.tsx',
    'components/credentials/create-credential-form.tsx',
    'components/credentials/generate-access-key-form.tsx',
    'components/connections/connections-tab.tsx',
    'components/connections/connect-sheet.tsx',
  ])('%s stays deleted', (rel) => {
    expect(existsSync(join(SRC, rel))).toBe(false)
  })

  it('nothing calls or links to a /connections address, on the page or the server', () => {
    const CONNECTIONS = /['"`]\/(connections|connectors|settings\/connections|ee\/connections)(\/|['"`?])/
    const hits = sourceFiles(SRC)
      .filter((f) => CONNECTIONS.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))
      .map((f) => relative(SRC, f))
    expect(hits).toEqual([])
  })

  it('has no route for /connections, /settings/connections or /workspaces', () => {
    const app = read('App.tsx')
    expect(app).not.toMatch(/path="\/(connections|settings\/connections|workspaces)[/"]/)
    expect(app + read('pages/credential-pages.tsx') + read('pages/workspace-detail.tsx')).not.toMatch(/AddressRedirect|AccessKeysRedirect/)
  })
})

describe('one pick-or-create control', () => {
  it('is what the API key, tool auth, MCP server token, npm registry token and memory accounts use', () => {
    for (const rel of ['components/apis/api-key-form.tsx', 'components/tools/tool-form.tsx', 'components/tools/mcp-server-form.tsx', 'components/apis/sdk-api-form.tsx', 'pages/memories.tsx']) {
      const source = read(rel)
      expect(importsFrom(source, '@/components/credentials/credential-picker'), rel).toContain('CredentialPicker')
      expect(importsFrom(source, '@/components/connections/connect-flow'), rel).not.toContain('ConnectAccountButton')
      expect(importsFrom(source, '@/components/connections/connection-select'), rel).not.toContain('ConnectionSelect')
    }
  })

  it('has no new look-alikes: the older add button and select are used only where they were', () => {
    // The model provider forms and the channel form move to CredentialPicker
    // with their own reworks; nothing new may join them.
    const users = sourceFiles(SRC)
      .filter((f) => /\b(ConnectAccountButton|ConnectionSelect)\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
      .filter((rel) => !rel.startsWith('components/connections/'))
      .sort()
    expect(users).toEqual([
      'components/gateways/detail/channel-config-form.tsx',
      'components/llm-providers/connect-provider-form.tsx',
      'components/llm-providers/credential-slot.tsx',
      'pages/provider.tsx',
    ])
  })

  it('leaves no secret to be typed into an API, tool or package form itself', () => {
    // Basic auth, an OAuth sign-in and a registry token are credentials too.
    // The only secret fields left are an OAuth app's client secret (the
    // sign-in that makes the credential) and a tool's custom header values.
    const apiKey = read('components/apis/api-key-form.tsx')
    expect(apiKey).not.toMatch(/id="api-key-value"|id="api-key-username"/)
    expect(apiKey).toMatch(/BASIC_AUTH_SERVICE = 'basic-auth'/)
    expect(apiKey).toMatch(/OAUTH2_SIGN_IN_SERVICE = 'oauth2'/)
    expect(apiKey).toMatch(/createPanel=/)
    const toolForm = read('components/tools/tool-form.tsx')
    expect(toolForm).not.toMatch(/auth-password|auth-username|authConfig\.password/)
    expect(toolForm).toMatch(/'basic-auth'/)
    const sdkForm = read('components/apis/sdk-api-form.tsx')
    expect(importsFrom(sdkForm, '@/components/ui/secret-input')).toEqual([])
    expect(sdkForm).toMatch(/credentialId: registryCredentialId/)
  })

  it('creates inline with the same add flow as the Credentials page, and links to what was picked', () => {
    const picker = read('components/credentials/credential-picker.tsx')
    expect(importsFrom(picker, '@/components/connections/connect-flow')).toContain('ConnectFlow')
    expect(picker).toMatch(/embedded/)
    expect(picker).toMatch(/credentialPath\(selected\.id\)/)
    expect(picker).toMatch(/Create one here/)
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
    .filter((s) => /\s/.test(s) || /^[A-Z][a-z]/.test(s))
    // A type annotation read between generics' angle brackets is code, not copy.
    .filter((s) => !/\?:|\s\|\s|=>/.test(s))
}

/** What adding a credential never says. The Advanced tab may; it is for admins. */
const JARGON = /\bvault\b|\bconnectors?\b|\bgrants?\b|\bOAuth\b|\bvalidat|\bowner\b|\brotat/i

export function jargon(source: string): string[] {
  return readableStrings(source).filter((s) => JARGON.test(s))
}

describe('adding a credential speaks plainly', () => {
  const USER_FACING = [
    'pages/credentials.tsx',
    'pages/credential-new.tsx',
    'components/connections/connect-flow.tsx',
    'components/credentials/credential-detail.tsx',
    'components/credentials/credential-picker.tsx',
    'components/credentials/credential-rows.ts',
    'components/connections/connection-status.ts',
    'components/connect/service-tiles.tsx',
    'components/connect/connected-card.tsx',
    'components/connect/who-can-use.tsx',
    'components/connect/status-label.tsx',
    'components/access-keys/access-keys-section.tsx',
  ]

  it.each(USER_FACING)('%s', (rel) => {
    expect(jargon(read(rel))).toEqual([])
  })

  it('catches the words it is meant to catch', () => {
    for (const old of [`<p>Select a secret from vault...</p>`, `<Label>Owner</Label>`, `<p>Validation failed</p>`, `const s = 'Rotate OpenAI'`, `<h2>Add custom connector</h2>`]) {
      expect(jargon(old), old).not.toEqual([])
    }
    expect(jargon(`<Button>Add credential</Button>`)).toEqual([])
  })

  it('never calls them Connections, or adding one "Connect a service"', () => {
    // The owner's names: Credentials, and Add credential. The model provider
    // forms are reworked on their own (credential-slot.tsx and provider.tsx
    // still say it).
    const OLD_WORDS = /\bConnections\b|Connect a service|connected account/
    const hits = sourceFiles(SRC)
      .map((f) => ({ rel: relative(SRC, f), strings: readableStrings(readFileSync(f, 'utf8')) }))
      .filter(({ rel }) => !['components/llm-providers/credential-slot.tsx', 'pages/provider.tsx'].includes(rel))
      .flatMap(({ rel, strings }) => strings.filter((s) => OLD_WORDS.test(s)).map((s) => `${rel}: ${s}`))
    expect(hits).toEqual([])
  })
})
