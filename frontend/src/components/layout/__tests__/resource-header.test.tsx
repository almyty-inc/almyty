import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '@/test/setup'
import { ResourceHeader } from '../resource-header'

describe('ResourceHeader', () => {
  it('lays a detail page out like the agent page: breadcrumb, title with badges, actions group', () => {
    render(
      <ResourceHeader
        back={{ to: '/apis', label: 'APIs' }}
        title="Open-Meteo"
        badges={<span>OpenAPI</span>}
        subtitle="https://api.open-meteo.com"
        actionsLabel="API actions"
        actions={<button>Edit</button>}
      />,
    )
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(crumbs).toHaveTextContent('APIsOpen-Meteo')
    expect(screen.getByRole('link', { name: 'APIs' })).toHaveAttribute('href', '/apis')
    expect(screen.getByRole('button', { name: 'Back to APIs' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Open-Meteo' })).toBeInTheDocument()
    expect(screen.getByText('https://api.open-meteo.com')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'API actions' })).toContainElement(screen.getByRole('button', { name: 'Edit' }))
  })
})
