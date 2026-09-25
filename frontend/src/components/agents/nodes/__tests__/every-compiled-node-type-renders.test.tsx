/**
 * An ejected strategy graph has to be viewable.
 *
 * `nodeTypes` registered ten of the engine's twelve node types. `verify`
 * and `extract_context` were missing, and React Flow draws nothing for an
 * unregistered type — so every one of the five built-in strategies, each
 * of which compiles to at least one of them, ejected into a canvas with a
 * blank slot in it. Combined with a compiled verify node that arrived
 * without checkers, the user could not even add the thing the executor
 * demands.
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'

import { nodeTypes, NODE_TYPE_CONFIG, VerifyNode, ExtractContextNode } from '..'

/** Every node type the engine dispatches; see agent-node-executor.ts. */
const ENGINE_NODE_TYPES = [
  'input',
  'output',
  'llm_call',
  'tool_call',
  'condition',
  'transform',
  'loop',
  'parallel',
  'merge',
  'sub_agent',
  'verify',
  'extract_context',
]

const nodeProps = {
  selected: false,
  zIndex: 0,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  dragging: false,
} as any

describe('every node type a strategy compiles to has a component', () => {
  it.each(ENGINE_NODE_TYPES)('%s is registered', (type) => {
    expect(nodeTypes[type]).toBeDefined()
  })

  it('gives every registered type a label and a colour', () => {
    for (const type of Object.keys(nodeTypes)) {
      expect(NODE_TYPE_CONFIG[type as keyof typeof NODE_TYPE_CONFIG]?.label).toBeTruthy()
      expect(NODE_TYPE_CONFIG[type as keyof typeof NODE_TYPE_CONFIG]?.color).toBeTruthy()
    }
  })

  const draw = (ui: React.ReactElement) => render(<ReactFlowProvider>{ui}</ReactFlowProvider>)

  it('shows a compiled verify node what it checks with, rather than an empty box', () => {
    draw(
      <VerifyNode
        {...nodeProps}
        id="check"
        type="verify"
        data={{ roleKey: 'verifier', checkers: [{ name: 'verifier', roleKey: 'verifier' }], policy: 'any_fail_blocks' }}
      />,
    )
    expect(screen.getByText('Verify')).toBeInTheDocument()
    expect(screen.getByText(/1 checker: verifier/)).toBeInTheDocument()
    expect(screen.getByText(/any_fail_blocks/)).toBeInTheDocument()
  })

  it('says plainly when a verify node has no checkers, because that fails the run', () => {
    draw(<VerifyNode {...nodeProps} id="check" type="verify" data={{}} />)
    expect(screen.getByText('No checkers')).toBeInTheDocument()
  })

  it('shows a compiled extract_context node the role it compresses with', () => {
    draw(<ExtractContextNode {...nodeProps} id="extract" type="extract_context" data={{ roleKey: 'summariser' }} />)
    expect(screen.getByText('Extract context')).toBeInTheDocument()
    expect(screen.getByText('Role: summariser')).toBeInTheDocument()
  })
})
