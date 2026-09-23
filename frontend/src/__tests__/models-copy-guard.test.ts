import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * The Models section speaks of models, where they run, and inference
 * providers. A model hosted on your own cloud is still a model; the backend
 * calls that a deployment and nothing a user reads does. Tracked artifacts
 * are an implementation detail of hosting, and "register endpoint" is gone:
 * a server you run is a custom inference provider plus a model.
 *
 * This reads the source, so a label that brings any of it back fails here
 * rather than in a product review.
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

const USER_FACING = [
  ...sourceFiles(join(SRC, 'components/models')),
  join(SRC, 'pages/models.tsx'),
  join(SRC, 'pages/model-new.tsx'),
  join(SRC, 'pages/model-detail.tsx'),
  join(SRC, 'pages/hosted-model.tsx'),
  join(SRC, 'pages/llm-provider-new.tsx'),
  join(SRC, 'components/llm-providers/create-provider-form.tsx'),
  join(SRC, 'components/llm-providers/add-inference-provider-form.tsx'),
  join(SRC, 'pages/llm-providers.tsx'),
  join(SRC, 'lib/model-hosting.ts'),
  join(SRC, 'lib/deployments-api.ts'),
]

/** Words a person reads: JSX text and string literals, minus imports and comments. */
function readableStrings(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^import[\s\S]*?from '[^']*'/gm, '')
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
]

describe('Models section copy', () => {
  it.each(USER_FACING.map((f) => [relative(SRC, f), f]))('%s never says deployment, tracked artifact or register endpoint', (_name, file) => {
    const offending = readableStrings(readFileSync(file, 'utf8')).filter((s) => {
      if (TECHNICAL.some((re) => re.test(s))) return false
      return /deploy|tracked artifact|registered version|register endpoint|register-endpoint/i.test(s)
    })
    expect(offending).toEqual([])
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
 * No dialogs in the Models area. Creating and configuring happen on real
 * pages (/models/new, /models/:id, /llm-providers/new) or inline on the
 * page they belong to. The one exception is a short confirmation before
 * something is stopped or removed, which is an AlertDialog.
 */
describe('the Models area has no dialogs or sheets', () => {
  it.each(USER_FACING.map((f) => [relative(SRC, f), f]))('%s imports no Dialog or Sheet', (_name, file) => {
    const source = readFileSync(file, 'utf8')
    expect(source).not.toMatch(/from '@\/components\/ui\/(dialog|sheet)'/)
    expect(source).not.toMatch(/<(Dialog|Sheet)(Content)?[\s>]/)
  })
})
