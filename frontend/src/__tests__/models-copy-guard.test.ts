import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * The Models area speaks of providers and models, and nothing else.
 *
 * You connect a provider once and its models show up everywhere; a model
 * almyty runs on your own cloud account is still just a model. The backend
 * says deployment, model card and validation run; nothing a user reads
 * does. These read the source, so a label that brings any of it back fails
 * here rather than in a product review.
 */
const SRC = resolve(__dirname, '..')

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

/** Every file of the Models area a person reads. */
const USER_FACING = [
  ...sourceFiles(join(SRC, 'components/models')),
  join(SRC, 'pages/models.tsx'),
  join(SRC, 'pages/models-connect.tsx'),
  join(SRC, 'pages/provider.tsx'),
  join(SRC, 'pages/hosted-model.tsx'),
  join(SRC, 'pages/models-redirects.tsx'),
  join(SRC, 'components/model-picker.tsx'),
  join(SRC, 'components/llm-providers/connect-provider-form.tsx'),
  join(SRC, 'components/connect/who-can-use.tsx'),
  join(SRC, 'components/llm-providers/provider-status.tsx'),
  join(SRC, 'components/llm-providers/provider-catalog.ts'),
  join(SRC, 'components/llm-providers/schema.ts'),
  join(SRC, 'lib/model-hosting.ts'),
  join(SRC, 'lib/deployments-api.ts'),
]

/** Words a person reads: JSX text and string literals, minus imports and comments. */
function readableStrings(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^import[\s\S]*?from '[^']*'/gm, '')
    .replace(/^export \{[^}]*\} from '[^']*'/gm, '')
  const out: string[] = []
  for (const m of code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  // JSX text: between a tag's closing > and the next <, never an arrow (=>) or a generic (<T>).
  for (const m of code.matchAll(/(?<![=-])>([^<>{}()=;]+)</g)) out.push(m[1])
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Technical strings that name the backend, never shown as prose. */
const TECHNICAL = [
  /^model-deployments$/, // query key
  /^\/model-deployments/, // API path
  /^deployment$/, // the Connections layer's connector kind for cloud accounts
  /^deploy-\$\{adapter\.key\}$/, // connector key prefix
  /^deploying$/, // a status value
  /^deploymentName$/, // the Azure field's key in the request body
]

/** What the Models area never says to a person. */
const FORBIDDEN = /deploy|tracked artifact|registered version|register endpoint|model card|inference provider|validation run|\bvalidated?\b|where does it run/i

export function forbiddenCopy(source: string): string[] {
  return readableStrings(source).filter((s) => !TECHNICAL.some((re) => re.test(s)) && FORBIDDEN.test(s))
}

describe('Models area copy', () => {
  it.each(USER_FACING.map((f) => [relative(SRC, f), f]))('%s says provider and model, never the backend words', (_name, file) => {
    expect(forbiddenCopy(readFileSync(file, 'utf8'))).toEqual([])
  })

  it('catches the words it is meant to catch', () => {
    // The guard is only worth something if it recognises the old copy.
    for (const old of [
      `<p>A model becomes usable after one validation run passes.</p>`,
      `<Button>Add inference provider</Button>`,
      `const s = 'Not validated'`,
      `<span>Validated</span>`,
      `<h2>Where does it run?</h2>`,
      `<p>Your model cards</p>`,
      `<Label>Deployment name</Label>`,
    ]) {
      expect(forbiddenCopy(old), old).not.toEqual([])
    }
    expect(forbiddenCopy(`<Button>Check again</Button>`)).toEqual([])
    expect(forbiddenCopy(`const key = ['model-deployments', orgId]`)).toEqual([])
  })
})

describe('register-endpoint is gone from the frontend', () => {
  it('no source file calls it or renders it', () => {
    const everything = sourceFiles(SRC)
    const hits = everything.filter((f) => /register-endpoint|registerEndpoint|RegisterEndpoint/.test(readFileSync(f, 'utf8')))
    expect(hits.map((f) => relative(SRC, f))).toEqual([])
  })
})

/**
 * "Add model", with its "Where does it run?" chooser and three forms, and
 * the separate inference-provider pages, are one flow now: connect a
 * provider. Their files stay deleted and nothing links to their addresses;
 * the old addresses only redirect.
 */
describe('the old add-model flow is gone', () => {
  const REMOVED = [
    'pages/model-new.tsx',
    'pages/model-detail.tsx',
    'pages/llm-providers.tsx',
    'pages/llm-provider-new.tsx',
    'pages/llm-provider-detail.tsx',
    'pages/llm-provider-edit.tsx',
    'components/models/provider-model-form.tsx',
    'components/models/server-model-form.tsx',
    'components/models/models-catalog.tsx',
    'components/models/hosting/host-model-form.tsx',
    'components/models/hosting/cloud-picker.tsx',
    'components/llm-providers/add-inference-provider-form.tsx',
    'components/llm-providers/create-provider-form.tsx',
    'components/llm-providers/edit-provider-form.tsx',
  ]

  it.each(REMOVED)('%s stays deleted', (rel) => {
    expect(existsSync(join(SRC, rel))).toBe(false)
  })

  it('no screen asks where a model runs', () => {
    const hits = sourceFiles(SRC).filter((f) => /Where does it run/i.test(readFileSync(f, 'utf8')))
    expect(hits.map((f) => relative(SRC, f))).toEqual([])
  })

  it('nothing links to the old addresses, which only redirect', () => {
    // App.tsx declares the redirects themselves; lib/api.ts calls the
    // /llm-providers API, which is not a page.
    const OLD = /['"`]\/(llm-providers\/new|models\/new|llm-providers\/\$\{)|['"`]\/llm-providers['"`?]/
    const hits = sourceFiles(SRC)
      .filter((f) => !f.endsWith('App.tsx') && !f.endsWith(join('lib', 'api.ts')))
      .filter((f) => OLD.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))
    expect(hits.map((f) => relative(SRC, f))).toEqual([])
  })
})

/**
 * No dialogs in the Models area. Connecting and configuring happen on real
 * pages (/models/connect, /models/providers/:id) or inline on them. The one
 * exception is a short confirmation before something is stopped or
 * removed, which is an AlertDialog.
 */
describe('the Models area has no dialogs or sheets', () => {
  it.each(USER_FACING.map((f) => [relative(SRC, f), f]))('%s imports no Dialog or Sheet', (_name, file) => {
    const source = readFileSync(file, 'utf8')
    expect(source).not.toMatch(/from '@\/components\/ui\/(dialog|sheet)'/)
    expect(source).not.toMatch(/<(Dialog|Sheet)(Content)?[\s>]/)
  })
})
