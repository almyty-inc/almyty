import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ReadinessBanner } from '../readiness-banner'

describe('ReadinessBanner', () => {
  it('names missing setup and provides the appropriate configuration actions', () => {
    const configure = vi.fn(), retry = vi.fn()
    render(<MemoryRouter><ReadinessBanner pending={false} failed={false} result={{ ready: false, message: 'Role principal needs a model' }} onRetry={retry} onConfigure={configure} /></MemoryRouter>)
    expect(screen.getByRole('alert')).toHaveTextContent('Not ready to activate')
    expect(screen.getByRole('link', { name: 'Open Models' })).toHaveAttribute('href', '/models')
    fireEvent.click(screen.getByRole('button', { name: 'Configure execution' }))
    fireEvent.click(screen.getByRole('button', { name: 'Recheck setup' }))
    expect(configure).toHaveBeenCalledOnce()
    expect(retry).toHaveBeenCalledOnce()
  })
  it('does not call a network failure a missing model', () => {
    render(<MemoryRouter><ReadinessBanner pending={false} failed onRetry={vi.fn()} onConfigure={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not check model setup')
    expect(screen.queryByRole('link', { name: 'Open Models' })).not.toBeInTheDocument()
  })
})
