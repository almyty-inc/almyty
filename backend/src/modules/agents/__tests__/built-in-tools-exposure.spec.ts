import { AgentRuntimeBuilders } from '../agent-runtime-builders'
import { BUILT_IN_TOOLS } from '../agent-runtime.service'
import type { Tool } from '../../../entities/tool.entity'
import type { Agent } from '../../../entities/agent.entity'

// Regression for #115: request_approval was a registered BUILT_IN_TOOL
// but never made it into the tool definitions handed to the LLM, so
// agents physically couldn't pause for human approval — every HITL
// run started with the tool missing and the planner improvised.
//
// We rebuild a minimal agent + tool list and confirm that every
// built-in tool (including request_approval) shows up in the LLM
// definitions, and that memory tools are gated on memoryConfig.

const minimalAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'agent-1',
  name: 'a',
  pipeline: { nodes: [], edges: [] } as any,
  memoryConfig: { enabled: false } as any,
  agentConfig: {} as any,
  ...overrides,
} as Agent)

describe('AgentRuntimeBuilders.buildToolDefinitions — built-in exposure', () => {
  const builders = new AgentRuntimeBuilders({} as any)

  it('exposes wait, ask_user, and request_approval to every agent', () => {
    const defs = builders.buildToolDefinitions([], minimalAgent())
    const names = defs.map(d => d.name)
    expect(names).toContain(BUILT_IN_TOOLS.wait.name)
    expect(names).toContain(BUILT_IN_TOOLS.ask_user.name)
    expect(names).toContain(BUILT_IN_TOOLS.request_approval.name)
  })

  it('omits store_memory + recall_memory when memoryConfig.enabled is false', () => {
    const defs = builders.buildToolDefinitions([], minimalAgent({ memoryConfig: { enabled: false } as any }))
    const names = defs.map(d => d.name)
    expect(names).not.toContain(BUILT_IN_TOOLS.store_memory.name)
    expect(names).not.toContain(BUILT_IN_TOOLS.recall_memory.name)
  })

  it('includes store_memory + recall_memory when memoryConfig.enabled is true', () => {
    const defs = builders.buildToolDefinitions([], minimalAgent({ memoryConfig: { enabled: true } as any }))
    const names = defs.map(d => d.name)
    expect(names).toContain(BUILT_IN_TOOLS.store_memory.name)
    expect(names).toContain(BUILT_IN_TOOLS.recall_memory.name)
  })

  it('still includes user-defined tools alongside the built-ins', () => {
    const userTool = { name: 'my_user_tool', description: 'd', parameters: {} } as Tool
    const defs = builders.buildToolDefinitions([userTool], minimalAgent())
    const names = defs.map(d => d.name)
    expect(names).toContain('my_user_tool')
    expect(names).toContain(BUILT_IN_TOOLS.request_approval.name)
  })
})
