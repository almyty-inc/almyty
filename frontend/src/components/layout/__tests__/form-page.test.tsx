import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import {
  createMemoryRouter,
  Link,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
} from 'react-router-dom'

import { Field, FormPage } from '@/components/layout/form-page'
import { SecretInput } from '@/components/ui/secret-input'
import { useLeaveGuard, LEAVE_TITLE } from '@/hooks/use-leave-guard'
import { useNewParamRedirect } from '@/hooks/use-new-param-redirect'
import { Input } from '@/components/ui/input'

// src/test/setup.tsx stubs useNavigate and useSearchParams for every suite.
// These tests are about navigation, so they need the real router.
vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

function NameForm({ onSaved }: { onSaved?: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | undefined>()
  const guard = useLeaveGuard(name !== '')
  return (
    <FormPage
      title="Create widget"
      back={{ to: '/widgets', label: 'Widgets' }}
      guard={guard}
      submitLabel="Create widget"
      onSubmit={() => {
        if (!name.trim() || name === 'bad') {
          setError('Name is required')
          return
        }
        onSaved?.()
        guard.leave('/widgets/1')
      }}
    >
      <Field id="other" label="Other">
        <Input />
      </Field>
      <Field id="name" label="Name" hint="Shown in the list." error={error}>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Link to="/elsewhere">Elsewhere</Link>
    </FormPage>
  )
}

function renderWithDataRouter(initial = '/widgets/new') {
  const router = createMemoryRouter(
    [
      { path: '/widgets/new', element: <NameForm /> },
      { path: '/widgets', element: <p>Widget list</p> },
      { path: '/widgets/1', element: <p>Widget one</p> },
      { path: '/elsewhere', element: <p>Somewhere else</p> },
    ],
    { initialEntries: ['/widgets', initial], initialIndex: 1 },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('FormPage', () => {
  it('has exactly one primary action and a Cancel, in a sticky footer', () => {
    renderWithDataRouter()
    const footer = screen.getByTestId('form-page-footer')
    expect(footer.className).toContain('sticky')
    const buttons = Array.from(footer.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Create widget'])
    expect(buttons.filter((b) => b.getAttribute('type') === 'submit')).toHaveLength(1)
  })

  it('focuses the first invalid field after a failed submit', async () => {
    renderWithDataRouter()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create widget' }))
    const name = screen.getByLabelText('Name')
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'))
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(name.getAttribute('aria-describedby')).toContain('name-error')
  })

  it('a clean form leaves without asking', async () => {
    const router = renderWithDataRouter()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/widgets'))
  })

  it('a dirty form asks before a link, Cancel or Back throws the work away', async () => {
    const router = renderWithDataRouter()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Half typed' } })

    fireEvent.click(screen.getByText('Elsewhere'))
    expect(await screen.findByText(LEAVE_TITLE)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByText(LEAVE_TITLE)).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe('/widgets/new')
    expect(screen.getByLabelText('Name')).toHaveValue('Half typed')

    // The browser back button goes through the same blocker.
    await act(async () => {
      await router.navigate(-1)
    })
    expect(await screen.findByText(LEAVE_TITLE)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/widgets'))
  })

  it('a successful save leaves without asking', async () => {
    const router = renderWithDataRouter()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Good name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create widget' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/widgets/1'))
    expect(screen.queryByText(LEAVE_TITLE)).not.toBeInTheDocument()
  })

  it('asks on Cancel without a data router too', async () => {
    render(
      <MemoryRouter initialEntries={['/widgets/new']}>
        <Routes>
          <Route path="/widgets/new" element={<NameForm />} />
          <Route path="/widgets" element={<p>Widget list</p>} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText(LEAVE_TITLE)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(await screen.findByText('Widget list')).toBeInTheDocument()
  })

  it('registers a beforeunload prompt only while dirty', () => {
    const add = vi.spyOn(window, 'addEventListener')
    renderWithDataRouter()
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(1)
    add.mockRestore()
  })
})

describe('SecretInput', () => {
  it('opts out of password managers and autofill', () => {
    render(<SecretInput aria-label="Access token" />)
    const input = screen.getByLabelText('Access token')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveAttribute('data-1p-ignore')
    expect(input).toHaveAttribute('data-lpignore', 'true')
  })

  it('can stay unmasked for identifiers', () => {
    render(<SecretInput masked={false} aria-label="Phone number id" />)
    expect(screen.getByLabelText('Phone number id')).toHaveAttribute('type', 'text')
  })
})

describe('useNewParamRedirect', () => {
  function List() {
    useNewParamRedirect('/widgets/new')
    return <p>Widget list</p>
  }
  it('sends ?new=1 to the create page', async () => {
    render(
      <MemoryRouter initialEntries={['/widgets?new=1']}>
        <Routes>
          <Route path="/widgets" element={<List />} />
          <Route path="/widgets/new" element={<p>Create page</p>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('Create page')).toBeInTheDocument()
  })
  it('leaves a plain list alone', () => {
    render(
      <MemoryRouter initialEntries={['/widgets']}>
        <Routes>
          <Route path="/widgets" element={<List />} />
          <Route path="/widgets/new" element={<p>Create page</p>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('Widget list')).toBeInTheDocument()
  })
})
