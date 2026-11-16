/**
 * App copy that explains what a gateway or a tool is for says who can use
 * it in general words ("AI assistants, coding tools and other agents"),
 * never by naming other products. The per-client setup snippets on a
 * gateway's page are the exception: they are instructions for that client.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

const FILES = [
  'components/onboarding/page-intros.ts',
  'components/onboarding/guide-steps.ts',
  'pages/gateways.tsx',
  'components/gateways/create-gateway-form.tsx',
]

describe('copy about who can use a gateway', () => {
  it.each(FILES)('%s names no other product', (file) => {
    const strings = [...read(file).matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3])
    for (const text of strings) {
      expect(text, file).not.toMatch(/Claude Code|Claude Desktop|Cursor|Windsurf|Copilot|ChatGPT/)
    }
  })
})
