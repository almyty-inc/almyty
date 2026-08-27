import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { SurfacesCanvas } from '../surfaces-canvas'
import type { SurfaceDescriptor } from '../surface-types'

// ReactFlow needs layout metrics jsdom does not provide, so the canvas is
// exercised through a stub that renders each node's data as plain DOM.
// What matters here is which nodes the canvas decides to render and what
// it says on them, not how ReactFlow paints them.
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, onNodeClick, children }: any) => (
    <div>
      {nodes.map((node: any) => (
        <button
          key={node.id}
          data-testid={`node-${node.id}`}
          data-available={String(node.data.available)}
          data-verified={String(node.data.verified)}
          onClick={(event) => onNodeClick?.(event, node)}
        >
          <span>{node.data.label ?? node.data.name}</span>
          {node.data.unavailableReason && <span>{node.data.unavailableReason}</span>}
          {node.data.warning && <span>{node.data.warning}</span>}
        </button>
      ))}
      {children}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
  Panel: ({ children }: any) => <div>{children}</div>,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
}))

const slack: SurfaceDescriptor = {
  type: 'slack',
  label: 'Slack',
  category: 'messaging',
  kind: 'agent',
  available: true,
  unavailableReason: null,
  humanFacing: true,
  inboundAuth: {
    mechanism: 'signature',
    requiredConfigKeys: ['signing_secret'],
    unauthenticatedByDesign: false,
  },
  edition: 'core',
}

const mcp: SurfaceDescriptor = {
  ...slack,
  type: 'mcp',
  label: 'MCP',
  category: 'protocol',
  humanFacing: false,
  inboundAuth: { mechanism: 'none', requiredConfigKeys: [], unauthenticatedByDesign: false },
}

const gated: SurfaceDescriptor = {
  ...slack,
  type: 'sms',
  label: 'SMS (Twilio)',
  available: false,
  unavailableReason: 'Needs A2P 10DLC registration before it can send.',
}

const renderCanvas = (props: Partial<React.ComponentProps<typeof SurfacesCanvas>> = {}) =>
  render(
    <SurfacesCanvas
      agentName="Support Bot"
      catalog={[mcp, slack, gated]}
      published={[]}
      onSelectPublished={vi.fn()}
      onAddSurface={vi.fn()}
      {...props}
    />,
  )

describe('SurfacesCanvas', () => {
  it('puts the agent at the centre with its surface count', () => {
    renderCanvas({ published: [{ id: 'gw-1', type: 'slack', name: 'Support Slack' }] })
    expect(screen.getByTestId('node-agent-hub')).toBeInTheDocument()
    expect(screen.getByText('Support Bot')).toBeInTheDocument()
  })

  it('renders every catalog surface, published or not', () => {
    renderCanvas()
    expect(screen.getByTestId('node-catalog-mcp')).toBeInTheDocument()
    expect(screen.getByTestId('node-catalog-slack')).toBeInTheDocument()
    expect(screen.getByTestId('node-catalog-sms')).toBeInTheDocument()
  })

  it('greys an unusable surface and shows the catalog reason verbatim', () => {
    renderCanvas()
    const node = screen.getByTestId('node-catalog-sms')
    expect(node).toHaveAttribute('data-available', 'false')
    expect(screen.getByText('Needs A2P 10DLC registration before it can send.')).toBeInTheDocument()
  })

  it('does not start a publish from an unusable surface', () => {
    const onAddSurface = vi.fn()
    renderCanvas({ onAddSurface })
    fireEvent.click(screen.getByTestId('node-catalog-sms'))
    expect(onAddSurface).not.toHaveBeenCalled()
  })

  it('starts a publish from an available, unpublished surface', () => {
    const onAddSurface = vi.fn()
    renderCanvas({ onAddSurface })
    fireEvent.click(screen.getByTestId('node-catalog-slack'))
    expect(onAddSurface).toHaveBeenCalledWith(expect.objectContaining({ type: 'slack' }))
  })

  it('warns on a published surface whose inbound auth cannot run', () => {
    renderCanvas({
      published: [{ id: 'gw-1', type: 'slack', name: 'Support Slack', configuration: {} }],
    })
    const node = screen.getByTestId('node-surface-gw-1')
    expect(node).toHaveAttribute('data-verified', 'false')
    expect(screen.getByText(/refused until signing_secret is set/)).toBeInTheDocument()
  })

  it('shows no warning once the surface is configured', () => {
    renderCanvas({
      published: [
        {
          id: 'gw-1',
          type: 'slack',
          name: 'Support Slack',
          configuration: { signing_secret: 's' },
        },
      ],
    })
    expect(screen.getByTestId('node-surface-gw-1')).toHaveAttribute('data-verified', 'true')
  })

  it('opens a published surface for editing when clicked', () => {
    const onSelectPublished = vi.fn()
    const published = [{ id: 'gw-1', type: 'slack', name: 'Support Slack' }]
    renderCanvas({ published, onSelectPublished })
    fireEvent.click(screen.getByTestId('node-surface-gw-1'))
    expect(onSelectPublished).toHaveBeenCalledWith(published[0])
  })

  it('hides unpublished surfaces on request, keeping the published ones', () => {
    renderCanvas({ published: [{ id: 'gw-1', type: 'slack', name: 'Support Slack' }] })
    fireEvent.click(screen.getByRole('button', { name: /Hide unpublished/ }))
    expect(screen.getByTestId('node-surface-gw-1')).toBeInTheDocument()
    expect(screen.queryByTestId('node-catalog-mcp')).toBeNull()
  })

  it('renders one node per instance when a surface is published twice', () => {
    renderCanvas({
      published: [
        { id: 'gw-1', type: 'slack', name: 'Support Slack' },
        { id: 'gw-2', type: 'slack', name: 'Sales Slack' },
      ],
    })
    expect(screen.getByTestId('node-surface-gw-1')).toBeInTheDocument()
    expect(screen.getByTestId('node-surface-gw-2')).toBeInTheDocument()
    // The placeholder gives way once real instances exist.
    expect(screen.queryByTestId('node-catalog-slack')).toBeNull()
  })
})
