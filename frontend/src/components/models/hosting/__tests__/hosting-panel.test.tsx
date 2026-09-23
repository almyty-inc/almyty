import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { HostingPanel, describeSource } from '../hosting-panel'
import { hostedStatus } from '@/lib/model-hosting'
import { hfAdapter, makeDeployment, makeVersion } from './fixtures'
import type { SpendBudgetSummary } from '@/types/deployments'

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../../store/app', () => ({
  useNotifications: () => notify,
}))

const budget: SpendBudgetSummary = { id: 'b-1', agentId: null, llmProviderId: null, periodType: 'month', limitCents: 50000, behavior: 'reject', active: true }

function renderPanel(overrides: Parameters<typeof makeDeployment>[0] = {}, handlers: Partial<{ onScale: ReturnType<typeof vi.fn>; onTeardown: ReturnType<typeof vi.fn> }> = {}) {
  const onScale = handlers.onScale ?? vi.fn()
  const onTeardown = handlers.onTeardown ?? vi.fn()
  const utils = render(
    <HostingPanel
      deployment={makeDeployment({ providerType: 'huggingface-endpoints', ...overrides })}
      adapters={[hfAdapter]}
      versions={[makeVersion()]}
      budgets={[budget]}
      onScale={onScale}
      onTeardown={onTeardown}
    />,
  )
  return { onScale, onTeardown, ...utils }
}

describe('hostedStatus', () => {
  it('names every state in plain words', () => {
    const d = (state: any, extra: any = {}) => hostedStatus({ state, desired: { replicas: 1 }, actual: null, ...extra })
    expect(d('pending').label).toBe('Starting')
    expect(d('deploying').label).toBe('Starting')
    expect(d('ready', { actual: { replicas: 1 } }).label).toBe('Running')
    expect(d('ready', { actual: { replicas: 0 } }).label).toBe('Scaled to zero')
    expect(d('ready', { desired: { replicas: 0 } }).label).toBe('Stopped')
    expect(d('scaling').label).toBe('Resizing')
    expect(d('degraded').label).toBe('Needs attention')
    expect(d('tearing_down').label).toBe('Shutting down')
    expect(d('torn_down').label).toBe('Shut down')
    expect(d('orphaned').label).toBe('Missing from your cloud')
    expect(d('failed').label).toBe('Failed')
  })
})

describe('describeSource', () => {
  it('shows a pinned repository as a name and a short commit', () => {
    expect(describeSource('hf://meta-llama/Llama-3.1-8B-Instruct@5206a32e0bd3067aef1ce90f5528ade7d866253f')).toBe('meta-llama/Llama-3.1-8B-Instruct, pinned to 5206a32')
    expect(describeSource('s3://bucket/qwen@etag1')).toBe('bucket/qwen, pinned to etag1')
    expect(describeSource('bedrock://arn:aws:bedrock:model/x')).toBe('arn:aws:bedrock:model/x')
  })
})

describe('HostingPanel', () => {
  beforeEach(() => {
    notify.success.mockReset()
    notify.error.mockReset()
  })

  it('shows where it runs, its state, hourly cost, spend, budget, endpoint and last error', () => {
    renderPanel({
      state: 'degraded',
      desired: { replicas: 2, hardware: 'a10g', region: 'eu-west-1' },
      actual: { state: 'degraded', replicas: 1, url: 'https://ep.example.com/v1', spentCents: 250, ratePerHourCents: 30, message: 'one replica unhealthy' },
      lastReconcileAt: new Date().toISOString(),
      lastError: 'health check timed out',
      budgetId: 'b-1',
    })
    expect(screen.getByText('Your Hugging Face account (Inference Endpoint)')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText('$0.30/h')).toBeInTheDocument()
    expect(screen.getByText('$2.50')).toBeInTheDocument()
    expect(screen.getByText('$500.00 per month (whole org, hard stop)')).toBeInTheDocument()
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    expect(screen.getByText('https://ep.example.com/v1')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('health check timed out')
    expect(screen.getByText('acme/support-bot-v3, pinned to e3b0c442')).toBeInTheDocument()

    // The raw desired-versus-actual view is still there, one click away.
    expect(screen.queryByText('one replica unhealthy')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Technical details/ }))
    expect(screen.getByText('one replica unhealthy')).toBeInTheDocument()
    expect(screen.getByText('********')).toBeInTheDocument()
  })

  it('shows lineage as plain facts, not as an object to manage', () => {
    renderPanel({ state: 'ready', modelVersionId: 'v-1', desired: { replicas: 1, quantization: 'awq-int4' } })
    expect(screen.getByText('Based on qwen3-14b, awq-int4')).toBeInTheDocument()
  })

  it('never says deployment to the user', () => {
    const { container } = renderPanel({ state: 'ready', actual: { replicas: 1 } })
    fireEvent.click(screen.getByRole('button', { name: /Technical details/ }))
    expect(container.textContent ?? '').not.toMatch(/deploy/i)
  })

  it('copies the endpoint URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderPanel({ state: 'ready', actual: { url: 'https://ep.example.com/v1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy endpoint URL' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://ep.example.com/v1'))
    expect(notify.success).toHaveBeenCalledWith('Endpoint URL copied')
  })

  it('stops a running model only after confirmation', async () => {
    const { onScale } = renderPanel({ state: 'ready', desired: { replicas: 1 }, actual: { replicas: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByText('Stop this model?')).toBeInTheDocument()
    expect(screen.getByText(/stops billing for it/)).toBeInTheDocument()
    expect(onScale).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop' }).at(-1)!)
    expect(onScale).toHaveBeenCalledWith('d-1', 0)
  })

  it('starts a stopped model again at once: only stopping asks first', () => {
    const { onScale } = renderPanel({ state: 'ready', desired: { replicas: 0 }, actual: { replicas: 0, state: 'stopped' } })
    expect(screen.getByText('Stopped')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onScale).toHaveBeenCalledWith('d-1', 1)
  })

  it('changes the number of copies in place, rejects junk, and asks before 0 copies', async () => {
    const { onScale } = renderPanel({ state: 'ready', desired: { replicas: 1 } })
    const input = screen.getByLabelText('Copies')
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeDisabled()
    fireEvent.change(input, { target: { value: '-1' } })
    expect(apply).toBeDisabled()
    fireEvent.change(input, { target: { value: '3' } })
    expect(apply).toBeEnabled()
    fireEvent.click(apply)
    expect(onScale).toHaveBeenCalledWith('d-1', 3)

    onScale.mockClear()
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(apply)
    expect(await screen.findByText('Stop this model?')).toBeInTheDocument()
    expect(onScale).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Stop this model?')).not.toBeInTheDocument())
    expect(onScale).not.toHaveBeenCalled()
  })

  it('shuts down only after confirmation', async () => {
    const { onTeardown } = renderPanel({ state: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: 'Shut down' }))
    expect(await screen.findByText('Shut this model down?')).toBeInTheDocument()
    expect(onTeardown).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Shut down' }).at(-1)!)
    expect(onTeardown).toHaveBeenCalledWith('d-1')
  })

  it('offers nothing to press once a model is shut down', () => {
    renderPanel({ state: 'torn_down' })
    expect(screen.getByText('Shut down')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Shut down' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Copies')).not.toBeInTheDocument()
    // DELETE /model-deployments/:id is a teardown, never a record delete,
    // so the panel never promises to remove "the record".
    expect(screen.queryByRole('button', { name: /record/i })).not.toBeInTheDocument()
  })

  it('cleans up after a failed start through a teardown, after confirmation', async () => {
    const { onTeardown } = renderPanel({ state: 'failed', lastError: 'quota exceeded' })
    fireEvent.click(screen.getByRole('button', { name: 'Clean up on your cloud' }))
    expect(await screen.findByText('Clean up on your cloud?')).toBeInTheDocument()
    expect(onTeardown).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Clean up' }))
    expect(onTeardown).toHaveBeenCalledWith('d-1')
  })

  it('hides shut down while one is already in progress', () => {
    renderPanel({ state: 'tearing_down' })
    expect(screen.getByText('Shutting down')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Shut down' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear hosting record' })).not.toBeInTheDocument()
  })
})
