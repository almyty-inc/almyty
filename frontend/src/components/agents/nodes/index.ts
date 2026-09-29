export { InputNode } from './input-node'
export { OutputNode } from './output-node'
export { LlmCallNode } from './llm-call-node'
export { ToolCallNode } from './tool-call-node'
export { ConditionNode } from './condition-node'
export { TransformNode } from './transform-node'
export { MergeNode } from './merge-node'
export { ParallelNode } from './parallel-node'
export { SubAgentNode } from './sub-agent-node'
export { LoopNode } from './loop-node'
export { VerifyNode } from './verify-node'
export { ExtractContextNode } from './extract-context-node'
export { DecisionNode } from './decision-node'

import type { NodeTypes } from '@xyflow/react'
import { InputNode } from './input-node'
import { OutputNode } from './output-node'
import { LlmCallNode } from './llm-call-node'
import { ToolCallNode } from './tool-call-node'
import { ConditionNode } from './condition-node'
import { LoopNode } from './loop-node'
import { TransformNode } from './transform-node'
import { MergeNode } from './merge-node'
import { ParallelNode } from './parallel-node'
import { SubAgentNode } from './sub-agent-node'
import { VerifyNode } from './verify-node'
import { ExtractContextNode } from './extract-context-node'
import { DecisionNode } from './decision-node'

// Every type the engine runs and the strategy compiler can emit. A type
// missing here reaches React Flow unregistered, which draws nothing: an
// ejected `cascade` or `explore_extract_patch` graph showed a blank slot
// where its check and its extraction should have been.
export const nodeTypes: NodeTypes = {
  input: InputNode,
  output: OutputNode,
  llm_call: LlmCallNode,
  tool_call: ToolCallNode,
  condition: ConditionNode,
  loop: LoopNode,
  transform: TransformNode,
  merge: MergeNode,
  parallel: ParallelNode,
  sub_agent: SubAgentNode,
  verify: VerifyNode,
  extract_context: ExtractContextNode,
  decision: DecisionNode,
}

export type PipelineNodeType = keyof typeof nodeTypes

export const NODE_TYPE_CONFIG: Record<PipelineNodeType, { label: string; color: string; description: string }> = {
  input: { label: 'Input', color: 'bg-green-500', description: 'What the run starts with' },
  output: { label: 'Output', color: 'bg-red-500', description: 'What the run returns' },
  llm_call: { label: 'Model call', color: 'bg-blue-500', description: 'Call a model' },
  tool_call: { label: 'Tool call', color: 'bg-purple-500', description: 'Use a tool' },
  condition: { label: 'Condition', color: 'bg-amber-500', description: 'Go one way or another' },
  loop: { label: 'Loop', color: 'bg-rose-500', description: 'Repeat for each item in a list' },
  transform: { label: 'Transform', color: 'bg-zinc-500', description: 'Reshape data' },
  merge: { label: 'Merge', color: 'bg-teal-500', description: 'Join branches back together' },
  parallel: { label: 'Parallel', color: 'bg-orange-500', description: 'Run branches at once' },
  sub_agent: { label: 'Sub-agent', color: 'bg-violet-500', description: 'Run another agent' },
  verify: { label: 'Verify', color: 'bg-emerald-500', description: 'Check an answer against a spec' },
  extract_context: { label: 'Extract context', color: 'bg-sky-500', description: 'Sum up earlier steps' },
  decision: { label: 'Decision', color: 'bg-cyan-500', description: 'Pick one of a few options' },
}
