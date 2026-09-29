/**
 * The workflow step panels, rebuilt around what a person decides:
 *
 * - values from earlier steps are picked as "step › field" chips, stored as
 *   the same `{{...}}` templates as before, and never shown raw unless
 *   Advanced › Edit values as text is on;
 * - a tool step lists the tool's own parameters, each answered "Ask the
 *   user", "From an earlier step" or "Fixed value";
 * - the input step asks "What does it start with?", a message by default;
 * - the step id, tuning and non-default modes wait under Advanced;
 * - opening any saved graph and leaving it changes nothing, byte for byte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'

import { renderWithProviders } from '@/test/setup'
import { NodeConfigPanel } from '../node-config-panel'
import { getDefaultData } from '../builder/use-agent-pipeline'
import { earlierSteps, joinTemplate, parseTemplate, refLabel, stepName } from '../step-values'
import { mappingEntries, sourceOf, toMapping } from '../tool-step-inputs'
import { toolsApi } from '@/lib/api'
import fixtures from './fixtures/pipelines.json'
import { jsxLabels, titleCaseWords } from '@/test/jsx-labels'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]), getModels: vi.fn().mockResolvedValue([]) },
  toolsApi: { getAll: vi.fn() },
  agentsApi: { getAll: vi.fn().mockResolvedValue([{ id: 'agent-9', name: 'Researcher' }]) },
}))

vi.mock('@/store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => unknown) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Acme' } }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/components/models/routing-policy-editor', () => ({ RoutingPolicyField: () => null }))
vi.mock('@/components/JsonSchemaBuilder', () => ({ JsonSchemaBuilder: () => <div data-testid="schema-builder" /> }))
vi.mock('@/components/ui/code-editor', () => ({
  CodeEditor: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <textarea data-testid="code-editor" value={value || ''} onChange={(e) => onChange?.(e.target.value)} />
  ),
}))

// Radix's Select needs pointer APIs jsdom lacks; drive the same
// onValueChange through a native select labelled like the trigger.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react')
  const Ctx = React.createContext<string | undefined>(undefined)
  return {
    Select: ({ value, onValueChange, children }: any) => {
      let label: string | undefined
      React.Children.forEach(children, (c: any) => {
        if (c?.props?.['aria-label']) label = c.props['aria-label']
        if (c?.props?.id && !label) label = c.props.id
      })
      return React.createElement(
        'select',
        { value: value ?? '', 'aria-label': label, onChange: (e: any) => onValueChange?.(e.target.value) },
        React.createElement('option', { value: '' }, '--'),
        children,
      )
    },
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: any) => React.createElement('option', { value }, typeof children === 'string' ? children : value),
    _Ctx: Ctx,
  }
})

const WEATHER = {
  id: 'tool-weather',
  name: 'get_weather',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'Which city' },
      units: { type: 'string', title: 'Units' },
      days: { type: 'integer' },
    },
    required: ['city'],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(toolsApi.getAll).mockResolvedValue({ tools: [WEATHER] } as any)
})

const n = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data })

function renderPanel(node: Node, nodes: Node[], edges?: Edge[]) {
  const onUpdateNode = vi.fn()
  const view = renderWithProviders(<NodeConfigPanel node={node} nodes={nodes} edges={edges} onUpdateNode={onUpdateNode} onDeleteNode={vi.fn()} onClose={vi.fn()} />)
  return { ...view, onUpdateNode }
}

const openAdvanced = () => fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

// ─── The template format underneath ──────────────────────────────────────────

describe('templates split into text and chips, and go back together exactly', () => {
  it.each([
    '',
    'plain',
    '{{input.message}}',
    'Summarize: {{ nodes.llm_1.output }} and {{input.x}}!',
    '{{a}}{{b}}',
    'broken {{ never closed',
    "{{nodes.a.output}} === 'x'",
  ])('%j', (t) => {
    expect(joinTemplate(parseTemplate(t))).toBe(t)
  })

  it('names references by step and field', () => {
    const nodes = [n('in', 'input'), n('llm_a', 'llm_call'), n('llm_b', 'llm_call'), n('v', 'verify')]
    const steps = earlierSteps(null, nodes)
    expect(refLabel('input.message', steps, nodes)).toBe('Input › message')
    expect(refLabel('nodes.llm_b.output', steps, nodes)).toBe('Model call 2 › Answer')
    expect(refLabel('nodes.v.output.passed', steps, nodes)).toBe('Verify › Passed')
    expect(refLabel('nodes.gone.output.x', steps, nodes)).toBe('gone › x')
    expect(stepName(n('x', 'llm_call', { label: 'Draft' }), nodes)).toBe('Draft')
  })

  it('offers the steps before this one when it knows the wires, and the input always', () => {
    const nodes = [n('in', 'input'), n('a', 'llm_call'), n('b', 'llm_call'), n('c', 'tool_call'), n('out', 'output')]
    const edges = [
      { id: '1', source: 'in', target: 'a' },
      { id: '2', source: 'a', target: 'c' },
      { id: '3', source: 'c', target: 'out' },
    ] as Edge[]
    expect(earlierSteps(nodes[3], nodes, edges).map((s) => s.nodeId)).toEqual(['in', 'a'])
    // Without the wires, every other step that hands something on.
    expect(earlierSteps(nodes[3], nodes).map((s) => s.nodeId)).toEqual(['in', 'a', 'b'])
  })
})

// ─── Chips ───────────────────────────────────────────────────────────────────

describe('picking earlier values as chips', () => {
  const input = n('input_1', 'input', { schema: { type: 'object', properties: { message: { type: 'string' }, topic: { type: 'string' } } } })
  const draft = n('llm_1', 'llm_call', { userPromptTemplate: '{{input.message}}' })

  it('shows a saved template as words and chips, never as {{...}}', () => {
    const summary = n('llm_2', 'llm_call', { userPromptTemplate: 'Summarize {{nodes.llm_1.output}} about {{input.topic}}' })
    renderPanel(summary, [input, draft, summary])
    const field = screen.getByRole('textbox', { name: 'Message' })
    // Each chip carries its × to take it out; the words around it are as typed.
    expect(field.textContent!.replace(/×/g, '')).toBe('Summarize Model call 1 › Answer about Input › topic')
    expect(within(field).getAllByTestId('step-value-chip').map((c) => c.firstChild!.textContent)).toEqual(['Model call 1 › Answer', 'Input › topic'])
    expect(document.body.textContent).not.toContain('{{')
  })

  it('inserts the picked step and field as the template the engine reads', () => {
    const summary = n('llm_2', 'llm_call', { userPromptTemplate: 'Summarize: ' })
    const { onUpdateNode } = renderPanel(summary, [input, draft, summary])
    const field = screen.getByRole('textbox', { name: 'Message' })
    const insert = within(field.parentElement!).getByRole('button', { name: 'Insert a value' })
    fireEvent.click(insert)
    const list = screen.getByRole('listbox', { name: 'Insert into Message' })
    // Grouped by step, each field named plainly.
    expect(within(list).getByRole('group', { name: 'Input' })).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('option', { name: 'Model call 1 › Answer' }))
    expect(onUpdateNode).toHaveBeenLastCalledWith('llm_2', expect.objectContaining({ userPromptTemplate: 'Summarize: {{nodes.llm_1.output}}' }))
  })

  it('finds a value by searching the list', () => {
    const summary = n('llm_2', 'llm_call', { userPromptTemplate: '' })
    const { onUpdateNode } = renderPanel(summary, [input, draft, summary])
    fireEvent.click(within(screen.getByRole('textbox', { name: 'Instructions' }).parentElement!).getByRole('button', { name: 'Insert a value' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search earlier steps' }), { target: { value: 'topic' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search earlier steps' }), { key: 'Enter' })
    expect(onUpdateNode).toHaveBeenLastCalledWith('llm_2', expect.objectContaining({ systemPrompt: '{{input.topic}}' }))
  })

  it('takes a chip out with its ×', () => {
    const summary = n('llm_2', 'llm_call', { userPromptTemplate: 'A {{input.topic}} B' })
    const { onUpdateNode } = renderPanel(summary, [input, draft, summary])
    fireEvent.click(screen.getByRole('button', { name: 'Remove Input › topic' }))
    expect(onUpdateNode).toHaveBeenLastCalledWith('llm_2', expect.objectContaining({ userPromptTemplate: 'A  B' }))
  })

  it('keeps chips when the words around them are typed', () => {
    const summary = n('llm_2', 'llm_call', { userPromptTemplate: 'Hi {{input.topic}}' })
    const { onUpdateNode } = renderPanel(summary, [input, draft, summary])
    const field = screen.getByRole('textbox', { name: 'Message' })
    field.insertBefore(document.createTextNode('Say: '), field.firstChild)
    fireEvent.input(field)
    expect(onUpdateNode).toHaveBeenLastCalledWith('llm_2', expect.objectContaining({ userPromptTemplate: 'Say: Hi {{input.topic}}' }))
  })

  it('shows the raw templates only under Advanced › Edit values as text, and writes what is typed there as is', () => {
    const summary = n('llm_2', 'llm_call', { userPromptTemplate: 'Hi {{input.topic}}' })
    const { onUpdateNode } = renderPanel(summary, [input, draft, summary])
    expect(screen.queryByDisplayValue('Hi {{input.topic}}')).not.toBeInTheDocument()
    openAdvanced()
    fireEvent.click(screen.getByRole('switch', { name: 'Edit values as text' }))
    const raw = screen.getByDisplayValue('Hi {{input.topic}}')
    fireEvent.change(raw, { target: { value: 'Hi {{ input.topic }}!' } })
    expect(onUpdateNode).toHaveBeenLastCalledWith('llm_2', expect.objectContaining({ userPromptTemplate: 'Hi {{ input.topic }}!' }))
  })

  it('picks a condition\'s "if" from the list and keeps building the same expression', () => {
    const cond = n('cond_1', 'condition', { expression: '' })
    const { onUpdateNode } = renderPanel(cond, [input, draft, cond])
    fireEvent.click(screen.getByRole('combobox', { name: 'If' }))
    fireEvent.click(screen.getByRole('option', { name: 'Model call › Answer' }))
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'yes' } })
    expect(onUpdateNode).toHaveBeenLastCalledWith('cond_1', expect.objectContaining({ expression: "{{nodes.llm_1.output}} === 'yes'" }))
  })
})

// ─── Tool step ───────────────────────────────────────────────────────────────

describe('a tool step lists what the tool takes', () => {
  const input = n('input_1', 'input', { schema: { type: 'object', properties: {}, required: [] } })
  const draft = n('llm_1', 'llm_call', {})

  it('shows each parameter from the tool\'s schema by name, no keys to type', async () => {
    const tool = n('tool_1', 'tool_call', { toolId: 'tool-weather', toolName: 'get_weather', parameterMapping: [] })
    renderPanel(tool, [input, draft, tool])
    expect(await screen.findByTestId('tool-param-city')).toHaveTextContent('city')
    expect(screen.getByTestId('tool-param-units')).toHaveTextContent('Units (optional)')
    expect(screen.getByText('Which city')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('key')).not.toBeInTheDocument()
    expect(screen.queryByText(/Parameter mapping/i)).not.toBeInTheDocument()
  })

  it('"Ask the user" reads the run input and gives the input step the field', async () => {
    const tool = n('tool_1', 'tool_call', { toolId: 'tool-weather', parameterMapping: [] })
    const { onUpdateNode } = renderPanel(tool, [input, draft, tool])
    fireEvent.change(await screen.findByLabelText('Where city comes from'), { target: { value: 'ask' } })
    expect(onUpdateNode).toHaveBeenCalledWith('tool_1', expect.objectContaining({ parameterMapping: [{ key: 'city', value: '{{input.city}}' }] }))
    expect(onUpdateNode).toHaveBeenCalledWith(
      'input_1',
      expect.objectContaining({ schema: expect.objectContaining({ properties: { message: { type: 'string' }, city: { type: 'string', description: 'Which city' } } }) }),
    )
    // The builder selects the step written last; it stays on this one.
    expect(onUpdateNode.mock.calls.at(-1)![0]).toBe('tool_1')
  })

  it('"From an earlier step" picks a step and field', async () => {
    const tool = n('tool_1', 'tool_call', { toolId: 'tool-weather', parameterMapping: [{ key: 'units', value: '' }] })
    const { onUpdateNode } = renderPanel(tool, [input, draft, tool])
    fireEvent.change(await screen.findByLabelText('Where Units comes from'), { target: { value: 'step' } })
    fireEvent.click(screen.getByRole('combobox', { name: 'Units from' }))
    fireEvent.click(screen.getByRole('option', { name: 'Model call › Answer' }))
    expect(onUpdateNode).toHaveBeenLastCalledWith('tool_1', expect.objectContaining({ parameterMapping: [{ key: 'units', value: '{{nodes.llm_1.output}}' }] }))
  })

  it('"Fixed value" writes the text as typed', async () => {
    const tool = n('tool_1', 'tool_call', { toolId: 'tool-weather', parameterMapping: [{ key: 'units', value: 'metric' }] })
    const { onUpdateNode } = renderPanel(tool, [input, draft, tool])
    const box = await screen.findByLabelText('Units value')
    expect(box).toHaveValue('metric')
    fireEvent.change(box, { target: { value: 'imperial' } })
    expect(onUpdateNode).toHaveBeenLastCalledWith('tool_1', expect.objectContaining({ parameterMapping: [{ key: 'units', value: 'imperial' }] }))
  })

  it('reads each saved value back as the source it came from', async () => {
    const tool = n('tool_1', 'tool_call', {
      toolId: 'tool-weather',
      parameterMapping: { city: '{{input.city}}', units: '{{nodes.llm_1.output}}', days: 3, extra: 'kept' },
    })
    renderPanel(tool, [input, draft, tool])
    expect(await screen.findByLabelText('Where city comes from')).toHaveValue('ask')
    expect(screen.getByLabelText('Where Units comes from')).toHaveValue('step')
    expect(screen.getByLabelText('Where days comes from')).toHaveValue('fixed')
    expect(screen.getByRole('combobox', { name: 'Units from' })).toHaveTextContent('Model call › Answer')
  })

  it('keeps an object-shaped mapping an object, in order, with values the tool does not list', async () => {
    const tool = n('tool_1', 'tool_call', { toolId: 'tool-weather', parameterMapping: { extra: 'kept', city: 'Paris' } })
    const { onUpdateNode } = renderPanel(tool, [input, draft, tool])
    fireEvent.change(await screen.findByLabelText('city value'), { target: { value: 'Rome' } })
    expect(onUpdateNode).toHaveBeenLastCalledWith('tool_1', expect.objectContaining({ parameterMapping: { extra: 'kept', city: 'Rome' } }))
    // The value the tool does not list is under Advanced, editable.
    openAdvanced()
    expect(screen.getByLabelText('Value 1 name')).toHaveValue('extra')
  })

  it('leaves an optional parameter out on request', async () => {
    const tool = n('tool_1', 'tool_call', { toolId: 'tool-weather', parameterMapping: [{ key: 'city', value: 'Paris' }, { key: 'units', value: 'metric' }] })
    const { onUpdateNode } = renderPanel(tool, [input, draft, tool])
    fireEvent.change(await screen.findByLabelText('Where Units comes from'), { target: { value: 'none' } })
    expect(onUpdateNode).toHaveBeenLastCalledWith('tool_1', expect.objectContaining({ parameterMapping: [{ key: 'city', value: 'Paris' }] }))
  })

  it('reads a mapping in either shape', () => {
    expect(mappingEntries([{ key: 'a', value: 1 }])).toEqual([{ key: 'a', value: 1 }])
    expect(mappingEntries({ a: 1 })).toEqual([{ key: 'a', value: 1 }])
    expect(toMapping([{ key: 'a', value: 1 }], { a: 0 })).toEqual({ a: 1 })
    expect(toMapping([{ key: 'a', value: 1 }], [])).toEqual([{ key: 'a', value: 1 }])
    expect(sourceOf('city', '{{input.city}}')).toBe('ask')
    expect(sourceOf('city', '{{input.town}}')).toBe('step')
    expect(sourceOf('city', 'Paris')).toBe('fixed')
    expect(sourceOf('city', undefined)).toBe('none')
  })
})

// ─── Input step ──────────────────────────────────────────────────────────────

describe('the input step', () => {
  it('asks what the run starts with, a message by default, and writes nothing until changed', () => {
    const input = n('input_1', 'input', getDefaultData('input' as any))
    const { onUpdateNode } = renderPanel(input, [input])
    expect(screen.getByText('What does it start with?')).toBeInTheDocument()
    expect(screen.getByLabelText('Field 1 name')).toHaveValue('message')
    expect(screen.queryByTestId('schema-builder')).not.toBeInTheDocument()
    expect(onUpdateNode).not.toHaveBeenCalled()
  })

  it('adds a field next to the message', () => {
    const input = n('input_1', 'input', getDefaultData('input' as any))
    const { onUpdateNode } = renderPanel(input, [input])
    fireEvent.click(screen.getByRole('button', { name: 'Add a field' }))
    expect(onUpdateNode).toHaveBeenCalledWith('input_1', {
      schema: { type: 'object', properties: { message: { type: 'string' }, field_2: { type: 'string' } }, required: [] },
    })
  })

  it('keeps the whole schema under Advanced', () => {
    const input = n('input_1', 'input', getDefaultData('input' as any))
    renderPanel(input, [input])
    openAdvanced()
    expect(screen.getByTestId('schema-builder')).toBeInTheDocument()
  })
})

// ─── Advanced ────────────────────────────────────────────────────────────────

describe('what waits under Advanced', () => {
  it('the step id', () => {
    const llm = n('llm_call_17_2', 'llm_call', {})
    renderPanel(llm, [llm])
    expect(screen.queryByText('llm_call_17_2')).not.toBeInTheDocument()
    expect(screen.queryByText(/Node ID/i)).not.toBeInTheDocument()
    openAdvanced()
    expect(screen.getByTestId('step-id')).toHaveTextContent('llm_call_17_2')
  })

  it('temperature and length on a model call', () => {
    const llm = n('llm_1', 'llm_call', { temperature: 0.7 })
    renderPanel(llm, [llm])
    expect(screen.queryByText(/Temperature/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Longest answer/)).not.toBeInTheDocument()
    openAdvanced()
    expect(screen.getByText(/Temperature/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Longest answer/)).toBeInTheDocument()
  })

  it('how a merge combines, and a consensus threshold', () => {
    const merge = n('merge_1', 'merge', { strategy: 'consensus', consensusThreshold: 0.6 })
    renderPanel(merge, [merge])
    expect(screen.getByTestId('merge-summary')).toHaveTextContent('Passes on what most branches agree on.')
    expect(screen.queryByLabelText('How many must agree')).not.toBeInTheDocument()
    openAdvanced()
    expect(screen.getByLabelText('How many must agree')).toHaveValue(0.6)
  })

  it('how many items a loop takes', () => {
    const loop = n('loop_1', 'loop', { iterableExpression: '{{input.items}}', maxIterations: 100 })
    renderPanel(loop, [n('input_1', 'input', {}), loop])
    expect(screen.queryByLabelText('Most items')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Go through' })).toHaveTextContent('Input › items')
    openAdvanced()
    expect(screen.getByLabelText('Most items')).toHaveValue(100)
  })
})

// ─── Words ───────────────────────────────────────────────────────────────────

describe('the panels speak in sentence case', () => {
  const FILES = ['node-config-panel.tsx', 'tool-step-inputs.tsx', 'step-value-field.tsx', 'step-values.ts']
  const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8')

  it.each(FILES)('%s labels, choices and buttons', (file) => {
    const offenders = jsxLabels(read(file), ['Label', 'SelectItem', 'Button', 'TabsTrigger'])
      .flatMap((el) => el.variants.map((v) => ({ v, line: el.line })))
      .filter(({ v }) => titleCaseWords(v).length > 0)
      .map(({ v, line }) => `${file}:${line} "${v}"`)
    expect(offenders).toEqual([])
  })

  it('names steps in sentence case, whatever the palette says', async () => {
    const { STEP_NAMES } = await import('../step-values')
    expect(Object.values(STEP_NAMES).filter((name) => titleCaseWords(name).length > 0)).toEqual([])
  })

  it('no longer says node id, parameter mapping, iterable expression or option id', () => {
    const panel = FILES.map(read).join('\n')
    for (const old of ['Node ID', 'Parameter Mapping', 'Iterable Expression', 'Option 1 id', 'refused by this node', 'Input Schema', 'Output Template']) {
      expect(panel, old).not.toContain(old)
    }
  })
})

// ─── Round trip ──────────────────────────────────────────────────────────────

type Pipeline = { nodes: Array<Record<string, any>>; edges: Array<Record<string, any>> }

/** The builder's own starting graph and a node of every type as dropped, plus shapes older graphs carry. */
const HAND_WRITTEN: Array<{ name: string; pipeline: Pipeline }> = [
  {
    name: 'builder default',
    pipeline: {
      nodes: [
        { id: 'input_1', type: 'input', data: { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } },
        { id: 'llm_1', type: 'llm_call', data: { userPromptTemplate: '{{input.message}}' } },
        { id: 'output_1', type: 'output', data: { mapping: '{{nodes.llm_1.output}}' } },
      ],
      edges: [
        { id: 'e1', source: 'input_1', target: 'llm_1' },
        { id: 'e2', source: 'llm_1', target: 'output_1' },
      ],
    },
  },
  {
    name: 'every type as dropped',
    pipeline: {
      nodes: ['input', 'output', 'llm_call', 'tool_call', 'condition', 'transform', 'merge', 'parallel', 'sub_agent', 'loop', 'verify', 'extract_context', 'decision'].map((type) => ({
        id: `${type}_1`,
        type,
        data: getDefaultData(type as any),
      })),
      edges: [],
    },
  },
  {
    name: 'older and odder shapes',
    pipeline: {
      nodes: [
        { id: 'in', type: 'input', config: { schema: { type: 'object', properties: { city: { type: 'string' } } } } },
        { id: 'tool', type: 'tool_call', data: { toolId: 'tool-weather', parameterMapping: { city: '{{ input.city }}', days: 3, legacy: 'x' } } },
        { id: 'tool2', type: 'tool_call', data: { toolId: 'missing-tool', parameterMapping: [{ key: 'q', value: 'Summarize {{nodes.tool.output}}' }] } },
        { id: 'cond', type: 'condition', data: { expression: '{{nodes.tool.output.temp}} > 30 && true' } },
        { id: 'loop', type: 'loop', data: { iterableExpression: 'items: {{nodes.tool.output}}', maxIterations: 5 } },
        { id: 'sub', type: 'sub_agent', data: { agentId: 'agent-9', agentName: 'Researcher', inputMapping: [{ key: 'q', value: '{{input.city}}' }] } },
        { id: 'dec', type: 'decision', data: { question: { id: 'q', type: 'boolean', prompt: 'Hot?', options: [], optionsOrderPolicy: 'permute2' }, thresholds: { yes: 0.8 } } },
        { id: 'merge', type: 'merge', data: { strategy: 'best_of_n', judgeConfig: { providerId: 'p1', model: 'm' }, judgePrompt: 'pick' } },
        { id: 'verify', type: 'verify', data: { target: '{{nodes.tool.output}}', spec: 'must cite', policy: 'majority', checkers: [{ name: 'a', roleKey: 'verifier' }] } },
      ],
      edges: [{ id: 'e', source: 'in', target: 'tool' }],
    },
  },
]

const ALL: Array<{ name: string; pipeline: Pipeline }> = [...(fixtures as any).templates, ...(fixtures as any).strategies, ...HAND_WRITTEN]

/** The builder's own mapping of a saved node to a canvas node (agent-builder.tsx). */
const toCanvas = (p: Pipeline): { nodes: Node[]; edges: Edge[] } => ({
  nodes: p.nodes.map((raw) => ({ id: raw.id, type: raw.type, position: raw.position ?? { x: 0, y: 0 }, data: raw.data || raw.config || {} })),
  edges: p.edges as Edge[],
})

describe('opening a step and leaving it changes nothing', () => {
  const cases = ALL.flatMap((f) => toCanvas(f.pipeline).nodes.map((node) => [`${f.name} / ${node.id} (${node.type})`, f.name, node.id] as const))

  it.each(cases)('%s', async (_label, fixtureName, nodeId) => {
    const fixture = ALL.find((f) => f.name === fixtureName)!
    const { nodes, edges } = toCanvas(fixture.pipeline)
    const before = JSON.stringify(nodes)
    const node = nodes.find((x) => x.id === nodeId)!
    const { onUpdateNode } = renderPanel(node, nodes, edges)
    await waitFor(() => expect(toolsApi.getAll).toHaveBeenCalled())

    // Look around: open Advanced and every list, close them again.
    openAdvanced()
    for (const button of screen.queryAllByRole('button', { name: 'Insert a value' })) {
      fireEvent.click(button)
      fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search earlier steps' }), { key: 'Escape' })
    }
    for (const combo of screen.queryAllByRole('combobox').filter((c) => c.getAttribute('aria-haspopup') === 'listbox' && !c.id.includes('model'))) {
      fireEvent.click(combo)
      fireEvent.click(combo)
    }

    expect(onUpdateNode).not.toHaveBeenCalled()
    expect(JSON.stringify(nodes)).toBe(before)
  })

  it('shows no template syntax on any of them until asked', async () => {
    for (const fixture of ALL) {
      const { nodes, edges } = toCanvas(fixture.pipeline)
      for (const node of nodes) {
        const { unmount } = renderPanel(node, nodes, edges)
        const shown = document.body.textContent ?? ''
        expect(shown, `${fixture.name} / ${node.id}`).not.toContain('{{')
        unmount()
      }
    }
  })
})
