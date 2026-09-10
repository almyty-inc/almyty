import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/**
 * The words on screen, enforced rather than remembered.
 *
 * A naming pass is only worth doing once. Without a guard the old words
 * come back one component at a time, because each reintroduction looks
 * harmless on its own and nobody re-reads the whole product.
 *
 * Scoped to what a person reads: JSX text and quoted strings. Identifiers,
 * imports, CSS classes and env var names are ours and stay ours.
 */
const SRC = join(__dirname, '../..')

/** Our words for our code. None of these belong in front of a user. */
const BANNED: Array<[RegExp, string]> = [
  [/\bLLM\b/, 'say model, or Provider'],
  [/\bmodel cards?\b/i, 'say model'],
  [/\bprivacy tier\b/i, 'say privacy'],
  [/\bfallback chain\b/i, 'say fallbacks'],
  [/\bbudget headroom\b/i, 'say spend limit'],
  [/\brouting headroom\b/i, 'say all-model failure rate'],
  [/\bco-failure\b/i, 'say all-model failure rate'],
  [/\baccuracy rate\b/i, 'say all-model failure rate: high is bad'],
]

/**
 * Real product names and identifiers that contain a banned substring.
 * Each one is here because it names something outside almyty.
 */
const ALLOWED = [
  'LLM_ALLOW_PRIVATE_URLS', // env var on the almyty server
  'LiteLLM', // the price feed, a real project
  'vLLM', // a real inference server, used in an example name
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'test') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Quoted strings and JSX text, with the allowed names removed first. */
function readableText(source: string): string[] {
  let text = source
  for (const allowed of ALLOWED) text = text.split(allowed).join('')
  const quoted = text.match(/'[^'\n]{3,200}'|"[^"\n]{3,200}"|`[^`]{3,200}`/g) ?? []
  const jsx = text.match(/>[^<>{}\n]{3,200}</g) ?? []
  return [...quoted, ...jsx].filter((s) => !/^['"`][./@]/.test(s))
}

describe('the words on screen', () => {
  const files = sourceFiles(SRC)

  it('finds the source to check, so an empty sweep cannot pass', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it.each(BANNED)('never says %s (%s)', (pattern, instead) => {
    const offenders: string[] = []
    for (const file of files) {
      for (const text of readableText(readFileSync(file, 'utf8'))) {
        if (pattern.test(text)) offenders.push(`${file.slice(SRC.length + 1)}: ${text.trim()}`)
      }
    }
    expect(offenders, `${offenders.length} string(s) to fix — ${instead}`).toEqual([])
  })
})
