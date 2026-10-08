import { beforeEach, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../test/setup'
import { AccessScopeField } from '../access-scope-field'
import { organizationsApi } from '@/lib/api'
vi.mock('@/lib/api', () => ({ organizationsApi: { getTeams: vi.fn() } }))
beforeEach(() => vi.mocked(organizationsApi.getTeams).mockResolvedValue([{ id: 'team-1', name: 'Support' }]))
it('offers internal and outside access with an explicit selection', async () => {
  const change = vi.fn()
  const user = userEvent.setup()
  render(<AccessScopeField organizationId="org-1" value={{ accessScope: 'org', teamId: null }} onChange={change} />)
  expect(screen.getByRole('radio', { name: /Everyone in the organization/ })).toHaveAttribute('aria-checked', 'true')
  await user.click(screen.getByRole('radio', { name: /Outside, protected/ }))
  expect(change).toHaveBeenCalledWith({ accessScope: 'external_protected', teamId: null })
  await waitFor(() => expect(screen.getByRole('radio', { name: /One team/ })).toBeEnabled())
  await user.click(screen.getByRole('radio', { name: /One team/ }))
  expect(change).toHaveBeenCalledWith({ accessScope: 'team', teamId: 'team-1' })
})
it('states the code mode restriction for an open endpoint', () => {
  render(<AccessScopeField organizationId="org-1" value={{ accessScope: 'external_open', teamId: null }} onChange={vi.fn()} />)
  expect(screen.getByText(/Scripts through code mode are unavailable/)).toBeInTheDocument()
})

it('supports arrow keys across the radio choices', async () => {
  const change = vi.fn()
  const user = userEvent.setup()
  render(<AccessScopeField organizationId="org-1" value={{ accessScope: 'org', teamId: null }} onChange={change} />)
  screen.getByRole('radio', { name: /Everyone in the organization/ }).focus()
  await user.keyboard('{ArrowRight}')
  expect(screen.getByRole('radio', { name: /Outside, open/ })).toHaveFocus()
  expect(change).toHaveBeenCalledWith({ accessScope: 'external_open', teamId: null })
})
