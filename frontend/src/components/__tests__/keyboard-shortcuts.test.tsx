import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { KeyboardShortcutsListener, SHORTCUTS } from '@/components/keyboard-shortcuts'
import { ShortcutsPage } from '@/pages/shortcuts'

// The global setup stubs useNavigate; `?` is a navigation now.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/tools']}>
      <KeyboardShortcutsListener />
      <input aria-label="Search" />
      <Routes>
        <Route path="/tools" element={<p>Tools page</p>} />
        <Route path="/shortcuts" element={<ShortcutsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('keyboard shortcuts', () => {
  it('? opens the shortcuts page, not a dialog', async () => {
    renderApp()
    fireEvent.keyDown(document.body, { key: '?' })
    expect(await screen.findByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(/Open the command palette/)).toBeInTheDocument()
  })

  it('? typed into a field stays in the field', () => {
    renderApp()
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: '?' })
    expect(screen.getByText('Tools page')).toBeInTheDocument()
  })

  it('lists only shortcuts something handles', () => {
    // "G then D", "N" and "/" were listed for years and never handled.
    const keys = SHORTCUTS.flatMap((g) => g.entries.map((e) => e.keys.join(' ')))
    expect(keys.sort()).toEqual(['?', 'Esc', '⌘ K'].sort())
  })
})
