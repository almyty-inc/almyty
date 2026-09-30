/**
 * One name per step, written the same way everywhere.
 *
 * The palette said "Model Call", "Sub-Agent" and "Extract Context" under a
 * shouted "NODE TYPES" heading; the side panel for the same step said
 * "Model call". Four places kept their own copy (the palette config, each
 * node's header, the side panel, the builder's checks) and drifted. The
 * panel's STEP_NAMES is the one list now; these checks hold the others to
 * it and to sentence case.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import { NODE_TYPE_CONFIG, type PipelineNodeType } from '..'
import { STEP_NAMES } from '../../step-values'
import { titleCaseWords } from '@/test/jsx-labels'

const NODES_DIR = join(__dirname, '..')
const AGENTS_DIR = join(__dirname, '..', '..')
const types = Object.keys(NODE_TYPE_CONFIG) as PipelineNodeType[]

describe('step labels', () => {
  it('are the same in the palette as in the side panel', () => {
    for (const type of types) expect(NODE_TYPE_CONFIG[type].label, type).toBe(STEP_NAMES[type])
  })

  it('are sentence case, and so are their descriptions', () => {
    const offenders = types.flatMap((type) => {
      const { label, description } = NODE_TYPE_CONFIG[type]
      return [label, description].filter((text) => titleCaseWords(text).length).map((text) => `${type}: "${text}"`)
    })
    expect(offenders).toEqual([])
  })

  it('are drawn as each node header on the canvas', () => {
    for (const type of types) {
      const src = readFileSync(join(NODES_DIR, `${type.replace(/_/g, '-')}-node.tsx`), 'utf8')
      const header = /<span className="text-xs font-semibold[^"]*">([^<]+)<\/span>/.exec(src)?.[1]
      expect(header, type).toBe(STEP_NAMES[type])
    }
  })

  it('have no Title Case text inside a node', () => {
    const offenders: string[] = []
    for (const type of types) {
      const file = `${type.replace(/_/g, '-')}-node.tsx`
      const src = readFileSync(join(NODES_DIR, file), 'utf8')
      for (const m of src.matchAll(/>([A-Z][^<>{}\n]+)</g)) {
        if (titleCaseWords(m[1].trim()).length) offenders.push(`${file}: "${m[1].trim()}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('come from one list in the builder checks, not a copy', () => {
    const src = readFileSync(join(AGENTS_DIR, 'builder', 'validate-graph.ts'), 'utf8')
    expect(src).toMatch(/import \{ STEP_NAMES \} from '\.\.\/step-values'/)
    expect(src).not.toMatch(/const STEP_NAMES/)
  })

  it('sit under a sentence-case palette heading, not a shouted one', () => {
    const src = readFileSync(join(AGENTS_DIR, 'node-palette.tsx'), 'utf8')
    expect(src).not.toMatch(/\buppercase\b/)
    expect(src).not.toMatch(/Node types/i)
  })
})
