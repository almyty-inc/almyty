import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * A provider and a model are chosen through ModelPicker and nowhere else.
 *
 * Every screen that asked for a model used to put a free-text box next to
 * a provider select, so the model was typed from memory and only found to
 * be wrong at run time. The shared picker makes the model a select of what
 * the provider actually offers. This fails when a bare text input bound to
 * a `model` field appears anywhere outside it, which is how the old shape
 * would come back.
 */
const SRC = join(__dirname, '..', '..')

/** The picker itself owns the one free-text model field (its escape hatch). */
const ALLOWED = new Set([
  'components/model-picker.tsx',
  // Creating a Vertex AI provider: there is no provider to pick from yet,
  // and that surface serves no model list, so the model has to be typed.
  'components/llm-providers/create-provider-form.tsx',
])

/** Areas another change is still rewriting; empty once they are converted. */
const PENDING_OWNER: string[] = []

/** An <Input ...> element's source, up to its self-closing end. */
function inputElements(source: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = []
  const re = /<Input\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const end = source.indexOf('/>', m.index)
    if (end === -1) continue
    out.push({ text: source.slice(m.index, end + 2), line: source.slice(0, m.index).split('\n').length })
  }
  return out
}

/**
 * Reads or writes a `model` value: `value={x.model}`, `model: e.target.value`,
 * `('model', e.target.value)`, or a react-hook-form `register('model')`.
 */
const BINDS_MODEL = /value=\{[^}]*\bmodel\b[^}]*\}|\bmodel\s*:\s*e\.target\.value|\(\s*['"]model['"]\s*,\s*e\.target\.value|register\(\s*['"]model['"]\s*\)/
/** The placeholder the old free-text fields all carried. */
const MODEL_PLACEHOLDER = /placeholder=["'{][^"'}]*(gpt-4o|claude-|Enter model name|model \(optional\)|Model \(optional\))/i

export function modelInputOffenders(files: Array<{ rel: string; source: string }>): string[] {
  const offenders: string[] = []
  for (const { rel, source } of files) {
    if (ALLOWED.has(rel)) continue
    if (PENDING_OWNER.some((p) => rel.startsWith(p))) continue
    for (const el of inputElements(source)) {
      // A read-only display of a saved value chooses nothing.
      if (/\breadOnly\b/.test(el.text)) continue
      if (BINDS_MODEL.test(el.text) || MODEL_PLACEHOLDER.test(el.text)) {
        offenders.push(`${rel}:${el.line}: ${el.text.split('\n')[0].trim()}`)
      }
    }
  }
  return offenders
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(full)
  }
  return out
}

function sourceFiles() {
  return walk(SRC).map((file) => ({
    rel: relative(SRC, file).split(/[\\/]/).join('/'),
    source: readFileSync(file, 'utf8'),
  }))
}

describe('model selection goes through ModelPicker', () => {
  it('no screen has a bare free-text model input', { timeout: 60_000 }, () => {
    const offenders = modelInputOffenders(sourceFiles())
    expect(offenders, `use <ModelPicker> from components/model-picker instead:\n${offenders.join('\n')}`).toEqual([])
  })

  it('catches the shapes it is meant to catch', () => {
    // The detector is only worth something if it recognises the old field.
    const old = [
      `<Input id="autonomous-model" value={modelConfig.model || ''} onChange={(e) => onModelConfigChange({ ...modelConfig, model: e.target.value })}\n  placeholder="e.g. gpt-4o, claude-sonnet-5" />`,
      `<Input value={(node.data.model as string) || ''} onChange={(e) => updateData('model', e.target.value)} />`,
      `<Input placeholder="model (optional)" value={checker.model || ''} onChange={(e) => patchChecker(i, { model: e.target.value })} />`,
    ]
    for (const source of old) {
      expect(modelInputOffenders([{ rel: 'pages/example.tsx', source }])).toHaveLength(1)
    }
    // A read-only display and an unrelated input are left alone.
    expect(modelInputOffenders([{ rel: 'pages/x.tsx', source: `<Input value={provider.configuration?.model || ''} readOnly />` }])).toEqual([])
    expect(modelInputOffenders([{ rel: 'pages/x.tsx', source: `<Input value={name} onChange={(e) => setName(e.target.value)} />` }])).toEqual([])
  })

  it('every provider-and-model screen renders the shared picker', () => {
    const sites = [
      'components/agents/builder/models-section.tsx',
      'components/agents/node-config-panel.tsx',
      'components/agents/detail/verify-config-editor.tsx',
      'components/tools/tool-form.tsx',
      'pages/chat.tsx',
      // A provider's default model, on /llm-providers/:id/edit.
      'components/llm-providers/edit-provider-form.tsx',
    ]
    for (const rel of sites) {
      const source = readFileSync(join(SRC, rel), 'utf8')
      expect(source, rel).toMatch(/from '@\/components\/model-picker'/)
      expect(source, rel).toMatch(/<ModelPicker\b/)
    }
  })

  it("a provider's edit page picks among that provider's models only", () => {
    // Its own select of the live list used to be here: an empty list read
    // "No models available" whatever the reason. The picker is locked to
    // the provider being edited, so no other provider can be chosen.
    const source = readFileSync(join(SRC, 'components/llm-providers/edit-provider-form.tsx'), 'utf8')
    const picker = source.slice(source.indexOf('<ModelPicker'), source.indexOf('/>', source.indexOf('<ModelPicker')))
    expect(picker).toMatch(/\bproviderLocked\b/)
    expect(picker).toMatch(/providerId: providerToEdit\.id/)
    expect(source).not.toMatch(/from '@\/components\/ui\/select'/)
  })
})
