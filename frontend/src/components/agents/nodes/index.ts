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
}

export type PipelineNodeType = keyof typeof nodeTypes

export const NODE_TYPE_CONFIG: Record<PipelineNodeType, { label: string; color: string; description: string }> = {
  input: { label: 'Input', color: 'bg-green-500', description: 'Pipeline input data' },
  output: { label: 'Output', color: 'bg-red-500', description: 'Pipeline output' },
  llm_call: { label: 'LLM Call', color: 'bg-blue-500', description: 'Call an LLM model' },
  tool_call: { label: 'Tool Call', color: 'bg-purple-500', description: 'Execute a tool' },
  condition: { label: 'Condition', color: 'bg-amber-500', description: 'Branch on condition' },
  loop: { label: 'Loop', color: 'bg-rose-500', description: 'Iterate over array' },
  transform: { label: 'Transform', color: 'bg-zinc-500', description: 'Transform data' },
  merge: { label: 'Merge', color: 'bg-teal-500', description: 'Merge parallel results' },
  parallel: { label: 'Parallel', color: 'bg-orange-500', description: 'Fan-out execution' },
  sub_agent: { label: 'Sub-Agent', color: 'bg-indigo-500', description: 'Run another agent' },
}
