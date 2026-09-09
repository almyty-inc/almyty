import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { DeploymentsList } from '../deployments-list'
import { makeDeployment, makeVersion, ollamaAdapter, hfAdapter } from './fixtures'

describe('DeploymentsList', () => {
  it('renders adapter, version, one badge per state, replicas, region, spend and burn rate', () => {
    const rows = [
      makeDeployment({ id: 'd-ready', state: 'ready', actual: { state: 'ready', replicas: 1, region: 'eu-west-1', spentCents: 1234, ratePerHourCents: 50 } }),
      makeDeployment({ id: 'd-deploying', state: 'deploying', providerType: 'huggingface-endpoints', desired: { replicas: 2, region: 'us-east-1' } }),
      makeDeployment({ id: 'd-failed', state: 'failed', lastError: 'credential rejected: 401' }),
      makeDeployment({ id: 'd-torn', state: 'torn_down' }),
    ]
    render(<DeploymentsList deployments={rows} adapters={[ollamaAdapter, hfAdapter]} versions={[makeVersion()]} onSelect={() => {}} />)

    expect(screen.getAllByText('Ollama').length).toBe(3)
    expect(screen.getByText('Hugging Face Endpoints')).toBeInTheDocument()
    expect(screen.getAllByText('support-bot-v3').length).toBe(4)

    expect(screen.getByText('ready')).toBeInTheDocument()
    expect(screen.getByText('deploying')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText('torn down')).toBeInTheDocument()

    expect(screen.getByText('$12.34')).toBeInTheDocument()
    expect(screen.getByText('$0.50/h')).toBeInTheDocument()
    expect(screen.getByText('eu-west-1')).toBeInTheDocument()
    expect(screen.getByText('us-east-1')).toBeInTheDocument()
    expect(screen.getByText('credential rejected: 401')).toBeInTheDocument()
  })

  it('shows actual over desired replicas and flags drift', () => {
    render(
      <DeploymentsList
        deployments={[makeDeployment({ desired: { replicas: 3 }, actual: { replicas: 1 } })]}
        adapters={[ollamaAdapter]}
        versions={[]}
        onSelect={() => {}}
      />,
    )
    const cell = screen.getByTitle('actual / desired')
    expect(cell).toHaveTextContent('1 / 3')
    expect(cell.className).toContain('amber')
  })

  it('falls back to the raw adapter key and a short id when lookups miss', () => {
    render(<DeploymentsList deployments={[makeDeployment({ providerType: 'modal', modelVersionId: '0123456789abcdef' })]} adapters={[]} versions={[]} onSelect={() => {}} />)
    expect(screen.getByText('modal')).toBeInTheDocument()
    expect(screen.getByText('01234567')).toBeInTheDocument()
  })

  it('opens the row on click and offers Deploy from the empty state', () => {
    const onSelect = vi.fn()
    const onDeploy = vi.fn()
    const { unmount } = render(<DeploymentsList deployments={[makeDeployment()]} adapters={[ollamaAdapter]} versions={[]} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('Ollama'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'd-1' }))
    unmount()

    render(<DeploymentsList deployments={[]} adapters={[]} versions={[]} onSelect={onSelect} onDeploy={onDeploy} />)
    expect(screen.getByText('No deployments yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Deploy a version' }))
    expect(onDeploy).toHaveBeenCalled()
  })
})
