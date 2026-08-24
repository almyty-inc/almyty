#!/usr/bin/env node
/**
 * Layer A copy check: invisible Unicode carriers (zero-width, BOM, NBSP).
 * Does not rewrite. Does not flag em-dashes (those are a marketing-site rule).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const CONTENT = join(import.meta.dirname, '..', 'content')
const EXTRA = [join(import.meta.dirname, '..', '..', 'README.md')]

const BANNED = [
  ['zero-width space U+200B', '\u200B'],
  ['zero-width non-joiner U+200C', '\u200C'],
  ['zero-width joiner U+200D', '\u200D'],
  ['BOM U+FEFF', '\uFEFF'],
  ['nbsp U+00A0', '\u00A0'],
]

const EXT = new Set(['.md', '.mdx', '.tsx', '.ts'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXT.has(p.slice(p.lastIndexOf('.')))) out.push(p)
  }
  return out
}

const repoRoot = join(import.meta.dirname, '..', '..')
const files = [...walk(CONTENT), ...EXTRA]
const errors = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(repoRoot, file)
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const [label, ch] of BANNED) {
      if (lines[i].includes(ch)) errors.push(`${rel}:${i + 1}: banned ${label}`)
    }
  }
}

if (errors.length) {
  console.error(`check-copy: ${errors.length} issue(s)\n`)
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}
console.log(`check-copy: ok (${files.length} files)`)
