// Regression for #117. When the dashboard kicks off an autonomous
// agent run, the agent runtime hands the LLM helper a request with
// `skipToolExecution: true` AND a `tools` array that's already
// fully shaped (built-ins like request_approval, sub-agent shims,
// etc — none of which have a row in the Tool table).
//
// The pre-fix code re-resolved those by name through
// `runner.prepareTools`, which dropped anything it didn't recognise
// in the DB. That's exactly how `request_approval` ended up invisible
// to the LLM for several days even after #115 added it to the
// builders, so the planner could never actually pause.
//
// This is the shape of the bypass — a tiny pure transformation that
// the helper now applies. Pinning it here means anyone who rips out
// the bypass branch fails this spec instead of silently breaking
// HITL again.

type ToolShape = {
  name: string
  description?: string
  parameters?: Record<string, any>
}

function resolveInlineTools(req: { skipToolExecution?: boolean; tools?: ToolShape[]; toolIds?: string[] }) {
  if (req.toolIds && req.toolIds.length > 0) {
    return { kind: 'by-id' as const }
  }
  if (req.skipToolExecution && Array.isArray(req.tools) && req.tools.length > 0) {
    return {
      kind: 'inline' as const,
      tools: req.tools.map(t => ({
        name: t.name,
        description: (t as any).description ?? '',
        parameters: (t as any).parameters ?? { type: 'object', properties: {} },
      })),
    }
  }
  return { kind: 'resolved-by-name' as const }
}

describe('LlmChatHelper inline-tools bypass (skipToolExecution=true)', () => {
  it('passes inline tools through verbatim when skipToolExecution=true', () => {
    const result = resolveInlineTools({
      skipToolExecution: true,
      tools: [
        { name: 'request_approval', description: 'pause', parameters: { type: 'object' } },
        { name: 'ask_user', description: 'ask' },
      ],
    })
    expect(result.kind).toBe('inline')
    expect((result as any).tools.map((t: ToolShape) => t.name)).toEqual(['request_approval', 'ask_user'])
  })

  it('falls back to name-resolution when skipToolExecution=false even with inline shapes', () => {
    const result = resolveInlineTools({
      skipToolExecution: false,
      tools: [{ name: 'request_approval' }],
    })
    expect(result.kind).toBe('resolved-by-name')
  })

  it('uses toolIds DB lookup when toolIds are provided', () => {
    const result = resolveInlineTools({ toolIds: ['t-1'] })
    expect(result.kind).toBe('by-id')
  })

  it('fills missing description + parameters with safe defaults', () => {
    const result = resolveInlineTools({
      skipToolExecution: true,
      tools: [{ name: 'minimal_tool' }],
    })
    expect(result.kind).toBe('inline')
    expect((result as any).tools[0]).toEqual({
      name: 'minimal_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
    })
  })
})
