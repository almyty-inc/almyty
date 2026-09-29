/**
 * CredentialPicker, the one "pick an existing credential or create one
 * here" control: lists what is on the Credentials page, creates inline with
 * the same add flow (never a dialog, never a nested form), hands the new
 * one back selected, and links to the picked one's own page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import { renderAtRoute } from '../../../test/render-at-route'
import { CredentialPicker, sortCredentialOptions } from '../credential-picker'
import { connectionsApi, connectorsApi } from '../../../lib/connections-api'
import type { Connection, Connector } from '@/types/connections'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return {
    ...actual,
    connectorsApi: { list: vi.fn(), create: vi.fn() },
    connectionsApi: { list: vi.fn(), connect: vi.fn(), complete: vi.fn(), validate: vi.fn(), rotate: vi.fn(), remove: vi.fn() },
  }
})
vi.mock('../../../lib/api', () => ({
  organizationsApi: { getById: vi.fn().mockResolvedValue({ id: 'org-1', plan: 'free', settings: {} }), getTeams: vi.fn().mockResolvedValue([]) },
}))
vi.mock('../../../store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Org' } }
    return selector ? selector(state) : state
  },
}))
vi.mock('../../../hooks/use-organization-role', () => ({ useOrganizationRole: () => ({ role: 'admin', canManage: true, isOwner: false }) }))

const other: Connector = {
  key: 'other',
  kind: 'tool_source',
  displayName: 'Other service',
  validation: { kind: 'format' },
  connect: [{ type: 'api_key', label: 'Key', schema: { type: 'object', properties: { apiKey: { type: 'string', title: 'Key', 'x-secret': true } }, required: ['apiKey'] } }],
}

function credential(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'c1',
    name: 'Stripe live',
    connectorKey: 'other',
    connectorDisplayName: 'Other service',
    kind: 'tool_source',
    owner: 'org',
    health: { status: 'valid' },
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A form that holds the picked id, like every consumer does. */
function Harness({ onChange, allowNone, error, hint, kind }: { onChange: (c: Connection | null) => void; allowNone?: boolean; error?: string; hint?: string; kind?: 'tool_source' | 'memory' }) {
  const [value, setValue] = useState('')
  return (
    <form aria-label="Consumer form" onSubmit={(e) => e.preventDefault()}>
      <CredentialPicker
        id="the-key"
        label="Key"
        value={value}
        kind={kind}
        connectorKey="other"
        defaultName="Petstore key"
        allowNone={allowNone}
        error={error}
        hint={hint}
        onChange={(c) => {
          setValue(c?.id ?? '')
          onChange(c)
        }}
      />
    </form>
  )
}

const at = (el: React.ReactElement) => renderAtRoute(el, { path: '/here', paths: ['/credentials/:id'] })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(connectorsApi.list).mockResolvedValue([other])
  vi.mocked(connectionsApi.list).mockResolvedValue([
    credential({ id: 'c2', name: 'GitHub bot', connectorKey: 'github', connectorDisplayName: 'GitHub', accountLabel: 'octocat' }),
    credential(),
    credential({ id: 'c3', name: 'Memory store', kind: 'memory', connectorKey: 'memory-custom', connectorDisplayName: 'Memory backend (HTTP)' }),
  ])
})

describe('CredentialPicker', () => {
  it('lists the credentials of its kind, the service\'s own first, and hands back the picked one', async () => {
    const onChange = vi.fn()
    at(<Harness onChange={onChange} kind="tool_source" />)
    fireEvent.click(await screen.findByRole('combobox', { name: 'Key' }))
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Stripe liveOther service', 'GitHub botGitHub, octocat'])
    fireEvent.click(options[1])
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }))
  })

  it('links to the picked credential\'s own page, in a new tab so the form survives', async () => {
    at(<Harness onChange={() => {}} kind="tool_source" />)
    fireEvent.click(await screen.findByRole('combobox', { name: 'Key' }))
    fireEvent.click(await screen.findByRole('option', { name: /Stripe live/ }))
    const open = await screen.findByTestId('credential-picker-open')
    expect(open).toHaveAttribute('href', '/credentials/c1')
    expect(open).toHaveAttribute('target', '_blank')
  })

  it('creates one here, inline in the form, and hands it back selected', async () => {
    const made = credential({ id: 'c9', name: 'Petstore key' })
    vi.mocked(connectionsApi.connect).mockResolvedValue({ pending: false, connection: made })
    const onChange = vi.fn()
    at(<Harness onChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create one here' }))

    const flow = await screen.findByTestId('connect-flow')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Inside the consumer's <form>, so it renders no form of its own.
    expect(screen.getByRole('form', { name: 'Consumer form' }).querySelectorAll('form')).toHaveLength(0)
    expect(await within(flow).findByText('Add a key')).toBeInTheDocument()
    expect(within(flow).getByLabelText('Name')).toHaveValue('Petstore key')

    fireEvent.change(within(flow).getByLabelText('Key'), { target: { value: 'sk_live_1' } })
    fireEvent.click(within(flow).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(connectionsApi.connect).toHaveBeenCalledWith('other', { method: 'api_key', owner: 'org', name: 'Petstore key', input: { apiKey: 'sk_live_1' } }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(made))
    expect(screen.queryByTestId('connect-flow')).not.toBeInTheDocument()
    expect(await screen.findByTestId('credential-picker-open')).toHaveTextContent('Open Petstore key')
  })

  it('folds the create panel away on Cancel', async () => {
    at(<Harness onChange={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create one here' }))
    const flow = await screen.findByTestId('connect-flow')
    fireEvent.click(within(flow).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('connect-flow')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create one here' })).toBeInTheDocument()
  })

  it('offers None where the credential is optional', async () => {
    const onChange = vi.fn()
    at(<Harness onChange={onChange} allowNone />)
    fireEvent.click(await screen.findByRole('combobox', { name: 'Key' }))
    fireEvent.click(await screen.findByRole('option', { name: /Stripe live/ }))
    fireEvent.click(await screen.findByRole('combobox', { name: 'Key' }))
    fireEvent.click(await screen.findByRole('option', { name: 'None' }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('says when there is nothing to pick yet, and shows its hint and error like any field', async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue([])
    at(<Harness onChange={() => {}} hint="Sent as a bearer token." error="Pick a key." />)
    const select = await screen.findByRole('combobox', { name: 'Key' })
    await waitFor(() => expect(select).toHaveTextContent('No credentials yet'))
    expect(select).toHaveAttribute('aria-invalid', 'true')
    expect(select.getAttribute('aria-describedby')).toBe('the-key-hint the-key-error')
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a key.')
    expect(screen.getByRole('button', { name: 'Create one here' })).toBeInTheDocument()
  })
})

describe('sortCredentialOptions', () => {
  it('puts the service\'s own credentials first, then the rest, by name', () => {
    const list = [credential({ id: 'b', name: 'B', connectorKey: 'github' }), credential({ id: 'z', name: 'Z' }), credential({ id: 'a', name: 'A', connectorKey: 'github' })]
    expect(sortCredentialOptions(list, 'other').map((c) => c.id)).toEqual(['z', 'a', 'b'])
    expect(sortCredentialOptions(list).map((c) => c.id)).toEqual(['a', 'b', 'z'])
  })
})
