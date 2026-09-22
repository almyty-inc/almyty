import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { DeploymentDetailSheet } from '../deployment-detail-sheet'
import { makeDeployment, makeVersion, ollamaAdapter } from './fixtures'

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../../store/app', () => ({
  useNotifications: () => notify,
}))

function renderSheet(overrides: Parameters<typeof makeDeployment>[0] = {}, handlers: Partial<{ onScale: ReturnType<typeof vi.fn>; onTeardown: ReturnType<typeof vi.fn>; onDelete: ReturnType<typeof vi.fn> }> = {}) {
  const onScale = handlers.onScale ?? vi.fn()
  const onTeardown = handlers.onTeardown ?? vi.fn()
  const onDelete = handlers.onDelete ?? vi.fn()
  render(
    <DeploymentDetailSheet
      deployment={makeDeployment(overrides)}
      adapters={[ollamaAdapter]}
      versions={[makeVersion()]}
      open
      onOpenChange={() => {}}
      onScale={onScale}
      onTeardown={onTeardown}
      onDelete={onDelete}
    />,
  )
  return { onScale, onTeardown, onDelete }
}

describe('DeploymentDetailSheet', () => {
  beforeEach(() => {
    notify.success.mockReset()
    notify.error.mockReset()
  })

  it('shows desired next to actual, the endpoint URL, the timeline and the last error', () => {
    renderSheet({
      state: 'degraded',
      desired: { replicas: 2, hardware: 'a10g', region: 'eu-west-1' },
      actual: { state: 'degraded', replicas: 1, url: 'https://ep.example.com/v1', spentCents: 250, ratePerHourCents: 30, message: 'one replica unhealthy' },
      lastReconcileAt: new Date().toISOString(),
      lastError: 'health check timed out',
    })
    expect(screen.getByText('Desired')).toBeInTheDocument()
    expect(screen.getByText('Actual')).toBeInTheDocument()
    expect(screen.getByText('https://ep.example.com/v1')).toBeInTheDocument()
    expect(screen.getByText('$2.50')).toBeInTheDocument()
    expect(screen.getByText('$0.30/h')).toBeInTheDocument()
    expect(screen.getByText('one replica unhealthy')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.getByText(/Last reconcile, now degraded/)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('health check timed out')
    // Secrets stay masked in the provider config block.
    expect(screen.getByText('********')).toBeInTheDocument()
  })

  it('copies the endpoint URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderSheet({ state: 'ready', actual: { url: 'https://ep.example.com/v1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy endpoint URL' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://ep.example.com/v1'))
    expect(notify.success).toHaveBeenCalledWith('Endpoint URL copied')
  })

  it('scales only after confirmation', async () => {
    const { onScale } = renderSheet({ state: 'ready', desired: { replicas: 1 } })
    const input = screen.getByLabelText('Replicas')
    const scale = screen.getByRole('button', { name: 'Scale' })
    expect(scale).toBeDisabled()
    fireEvent.change(input, { target: { value: '3' } })
    expect(scale).toBeEnabled()
    fireEvent.click(scale)

    expect(await screen.findByText('Scale to 3 replicas?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Scale to 3 replicas?')).not.toBeInTheDocument())
    expect(onScale).not.toHaveBeenCalled()

    fireEvent.click(scale)
    await screen.findByText('Scale to 3 replicas?')
    fireEvent.click(screen.getAllByRole('button', { name: 'Scale' }).at(-1)!)
    expect(onScale).toHaveBeenCalledWith('d-1', 3)
  })

  it('explains scale to zero and rejects junk replica counts', () => {
    renderSheet({ state: 'ready', desired: { replicas: 2 } })
    const input = screen.getByLabelText('Replicas')
    const scale = screen.getByRole('button', { name: 'Scale' })
    fireEvent.change(input, { target: { value: '-1' } })
    expect(scale).toBeDisabled()
    fireEvent.change(input, { target: { value: '0' } })
    expect(scale).toBeEnabled()
    fireEvent.click(scale)
    expect(screen.getByText('Scale to 0 replicas?')).toBeInTheDocument()
    expect(screen.getByText(/billing stops with it/)).toBeInTheDocument()
  })

  it('tears down only after confirmation', async () => {
    const { onTeardown } = renderSheet({ state: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: 'Tear down' }))
    expect(await screen.findByText('Tear down this deployment?')).toBeInTheDocument()
    expect(onTeardown).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Tear down' }).at(-1)!)
    expect(onTeardown).toHaveBeenCalledWith('d-1')
  })

  it('offers delete instead of scale or teardown for terminal rows', async () => {
    const { onDelete, onTeardown } = renderSheet({ state: 'torn_down' })
    expect(screen.queryByRole('button', { name: 'Tear down' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Replicas')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Delete this deployment record?')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    expect(onDelete).toHaveBeenCalledWith('d-1')
    expect(onTeardown).not.toHaveBeenCalled()
  })

  it('hides teardown while a teardown is already in progress', () => {
    renderSheet({ state: 'tearing_down' })
    expect(screen.queryByRole('button', { name: 'Tear down' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })
})
