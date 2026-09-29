/**
 * An SDK API from a private npm registry: the registry's token is a
 * credential the API points at, picked or made with the shared control,
 * and never typed into the form or kept on the API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '@/test/setup'
import { SdkApiForm } from '../sdk-api-form'
import { apisApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  apisApi: { createSdkApi: vi.fn() },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

// The picker is covered on its own; here it only has to hand back a pick.
vi.mock('@/components/credentials/credential-picker', () => ({
  CredentialPicker: ({ id, label, onChange }: { id: string; label: string; onChange: (c: { id: string } | null) => void }) => (
    <button type="button" id={id} onClick={() => onChange({ id: 'cred-npm' })}>
      Pick {label}
    </button>
  ),
}))

vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-test', name: 'Test Org' } }),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SDK API form', () => {
  it('sends the registry token as a credential it points at, not the token', async () => {
    vi.mocked(apisApi.createSdkApi).mockResolvedValue({ id: 'api-sdk' } as any)
    const user = userEvent.setup()
    render(<SdkApiForm />)

    await user.type(screen.getByLabelText(/^Name/), 'Internal SDK')
    await user.type(screen.getByLabelText('Package name'), '@acme/client')
    await user.click(screen.getByRole('button', { name: 'Add package' }))
    await user.click(screen.getByLabelText('Use a private npm registry'))

    // No field to type a token into.
    expect(screen.queryByPlaceholderText('npm auth token')).not.toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('https://registry.example.com'), 'https://npm.acme.test')
    await user.click(screen.getByRole('button', { name: 'Pick Auth token' }))
    await user.click(screen.getByRole('button', { name: 'Connect API' }))

    await waitFor(() => expect(apisApi.createSdkApi).toHaveBeenCalled())
    const body = vi.mocked(apisApi.createSdkApi).mock.calls[0][0]
    expect(body.npmRegistry).toEqual({ url: 'https://npm.acme.test', credentialId: 'cred-npm' })
    expect(JSON.stringify(body)).not.toMatch(/"token"|authToken/)
  })
})
