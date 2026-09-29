import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Apps: an app is never born empty, and the screens say "app".
 *
 * The create page asks for the agent with the one shared agent select, the
 * same one an app's Agents tab and a workflow's "run another agent" step
 * use. And "product", the word the factory was built under, is not what
 * anyone sees: these read the source with comments stripped.
 */
const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
const withoutComments = (text: string) =>
  text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('apps use the shared agent select', () => {
  it.each([
    'components/agent-apps/create-app-form.tsx',
    'components/agent-apps/app-agents-panel.tsx',
    'components/agents/node-config-panel.tsx',
  ])('%s picks an agent with AgentSelect', (file) => {
    const src = read(file)
    expect(src).toMatch(/import \{ AgentSelect[^}]*\} from '(@\/components\/agents|\.)\/agent-select'/)
  })

  it('creates an app with the agent it was asked for', () => {
    const src = read('components/agent-apps/create-app-form.tsx')
    expect(src).not.toMatch(/agentIds: \[\]/)
  })
})

describe('apps say "app", not "product"', () => {
  const files = [
    ...readdirSync(join(SRC, 'components/agent-apps'))
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => `components/agent-apps/${f}`),
    ...readdirSync(join(SRC, 'pages'))
      .filter((f) => /^apps?[-.]/.test(f) && /\.tsx$/.test(f))
      .map((f) => `pages/${f}`),
    'lib/agent-apps.ts',
  ]

  it.each(files)('%s', (file) => {
    expect(withoutComments(read(file))).not.toMatch(/\bproducts?\b/i)
  })
})
