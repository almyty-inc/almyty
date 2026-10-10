/**
 * The shared detail-page pieces: the header (back, logo, name, facts,
 * actions, one problem line), the details list and the danger zone.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { DetailHeader } from '@/components/layout/detail-header'
import { DetailItem, DetailList } from '@/components/ui/detail-list'
import { DangerZone } from '@/components/ui/danger-zone'

const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('DetailHeader', () => {
  it('has the back link, the name as the heading, the facts in order and the actions', () => {
    inRouter(
      <DetailHeader
        back={{ to: '/credentials', label: 'Credentials' }}
        icon={<svg data-testid="logo" />}
        title="Staging cluster"
        meta={[<span key="a">Kubernetes cluster</span>, null, <span key="b">Works</span>]}
        actions={<button type="button">Check again</button>}
      />,
    )
    expect(screen.getByRole('link', { name: 'Credentials' })).toHaveAttribute('href', '/credentials')
    const header = screen.getByRole('heading', { name: 'Staging cluster' }).closest('header')!
    expect(within(header).getByTestId('logo')).toBeInTheDocument()
    expect(header).toHaveTextContent('Kubernetes clusterWorks')
    expect(within(header).getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('shows a problem line only when there is a problem', () => {
    const { rerender } = inRouter(<DetailHeader back={{ to: '/x', label: 'X' }} title="A" problemTestId="p" />)
    expect(screen.queryByTestId('p')).not.toBeInTheDocument()
    rerender(
      <MemoryRouter>
        <DetailHeader back={{ to: '/x', label: 'X' }} title="A" problem="token rejected" problemTestId="p" />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('p')).toHaveTextContent('token rejected')
  })
})

describe('DetailList', () => {
  it('pairs each label with its value and puts the action after the value', () => {
    render(
      <DetailList>
        <DetailItem label="Key" value="Stored encrypted" action={<button type="button">Replace key</button>} testId="row" />
      </DetailList>,
    )
    expect(screen.getByRole('term')).toHaveTextContent('Key')
    expect(screen.getByRole('definition')).toHaveTextContent('Stored encrypted · Replace key')
  })
})

describe('DangerZone', () => {
  it('says what goes and holds the one destructive button', () => {
    render(<DangerZone title="Delete this credential" description="Nothing uses it." action={<button type="button">Delete credential</button>} variant="inline" />)
    const zone = screen.getByTestId('danger-zone')
    expect(within(zone).getByRole('heading', { name: 'Delete this credential' })).toBeInTheDocument()
    expect(zone).toHaveTextContent('Nothing uses it.')
    expect(within(zone).getByRole('button', { name: 'Delete credential' })).toBeInTheDocument()
  })
})
