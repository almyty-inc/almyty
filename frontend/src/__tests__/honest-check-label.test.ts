import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { CHECK_FAILED, CHECK_PASSED, CHECK_PASSED_EXPLANATION } from '@/components/agents/detail/verify-step'
import { CHECKS_PASSED_HINT, CHECKS_PASSED_LABEL } from '@/lib/agent-run-numbers'

/**
 * The answer check's pass label says what a pass means and no more.
 *
 * A pass means the check found no mismatch between the answer and what the
 * tools returned. It does not mean the answer is right: real runs still
 * passed with a made-up dependency name in a release summary and a
 * paraphrased quote, because there was nothing in the tool results to
 * compare them with. "Checks passed" read as "the answers are correct", so
 * the label is "No errors found" with a line on what was compared.
 *
 * These read the source of every surface that shows the check (the app,
 * both CLIs, the agent's technical document) and its docs, so wording
 * that makes a pass sound like a correct answer fails here.
 */
const ROOT = resolve(__dirname, '../../..')

function files(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
      out.push(...files(path, ext))
    } else if (ext.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

/** Words a person reads in code: string literals and JSX text, without comments. */
function readableStrings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out: string[] = []
  for (const m of code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  for (const m of code.matchAll(/(?<![=-])>([^<>{}()=;]+)</g)) out.push(m[1])
  return out.map((s) => s.trim()).filter(Boolean)
}

/** The old label, as a label. Prose may still say that a check passed. */
const OLD_LABEL = /\bChecks? passed\b/
/** A pass worded as if the answer were right. */
const CORRECTNESS = /verified (as )?correct|correctness (was )?(verified|confirmed)|\banswers? (was |were )?verified\b|\bverified answers?\b|\bpassed verification\b|\ball checks passed\b/i
const OVERCLAIM = { test: (s: string) => OLD_LABEL.test(s) || CORRECTNESS.test(s) }

/** Where the answer check is shown: the app, both CLIs, the technical document. */
const CODE = [
  ...files(join(ROOT, 'frontend/src'), /\.tsx?$/),
  ...files(join(ROOT, 'packages/agents-cli/src'), /\.ts$/),
  ...files(join(ROOT, 'packages/chat-cli/src'), /\.tsx?$/),
  join(ROOT, 'backend/src/modules/agents/agent-tech-doc.helper.ts'),
  join(ROOT, 'backend/src/modules/agents/unverified-answer.ts'),
]

/** Where the check is described for a person. */
const DOCS = [
  join(ROOT, 'docs/autonomous-models.md'),
  join(ROOT, 'docs-site/content/analytics.mdx'),
  ...files(join(ROOT, 'docs-site/content/agents'), /\.mdx?$/),
]

describe('the answer check says what a pass means', () => {
  it('labels a pass "No errors found", with what was compared and what it cannot confirm', () => {
    expect(CHECK_PASSED).toBe('No errors found')
    expect(CHECKS_PASSED_LABEL).toBe('No errors found')
    expect(CHECK_FAILED).toBe('Errors found')
    expect(CHECK_PASSED_EXPLANATION).toBe(
      "The check compared the answer's names, dates, versions, ids, counts and labels with what the tools returned and found no mismatch. It can't confirm everything the answer says.",
    )
    expect(CHECKS_PASSED_HINT).toMatch(/can't confirm everything/)
  })

  it.each(CODE.map((f) => [relative(ROOT, f), f]))('%s never words a pass as a correct answer', (_name, file) => {
    expect(readableStrings(readFileSync(file, 'utf8')).filter((s) => OVERCLAIM.test(s))).toEqual([])
  })

  it.each(DOCS.map((f) => [relative(ROOT, f), f]))('%s never words a pass as a correct answer', (_name, file) => {
    const hits = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => OVERCLAIM.test(line))
    expect(hits).toEqual([])
  })

  it('the docs say what the check can and cannot catch', () => {
    for (const file of [join(ROOT, 'docs/autonomous-models.md'), join(ROOT, 'docs-site/content/agents/autonomous.mdx')]) {
      const doc = readFileSync(file, 'utf8')
      expect(doc, relative(ROOT, file)).toMatch(/^### What the check can and can't catch$/m)
      // The markdown wraps lines; the sentence is the same either way.
      expect(doc.replace(/\s+/g, ' '), relative(ROOT, file)).toContain(CHECK_PASSED_EXPLANATION)
    }
  })

  it('the guard itself catches the old wording', () => {
    for (const old of ['Checks passed', 'Check passed', 'Answer verified', 'verified correct', 'passed verification']) {
      expect(OVERCLAIM.test(old), old).toBe(true)
    }
    for (const fine of ['No errors found', 'Errors found', 'Not checked', "Check didn't pass"]) {
      expect(OVERCLAIM.test(fine), fine).toBe(false)
    }
  })
})
