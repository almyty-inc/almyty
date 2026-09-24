/**
 * The API page's inline authentication and credential sections ask before
 * a navigation throws away what was typed into them. A clean section and
 * a cancelled one leave without asking.
 */
import { describe, it, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { fireEvent, screen } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { SecurityTab } from '../security-tab'
import { CredentialsTab } from '../credentials-tab'
import { apisApi } from '@/lib/api'
import type { Api } from '@/types'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  apisApi: {
    update: vi.fn(),
    getCredentials: vi.fn(),
    createCredential: vi.fn(),
    deleteCredential: vi.fn(),
    testCredential: vi.fn(),
  },
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

const at = (el: JSX.Element) => renderAtRoute(el, { path: '/apis/api-1', paths: ['/elsewhere'] })

const API = {
  id: 'api-1',
  name: 'Northwind',
  authentication: { type: 'bearer_token', config: { token: 'saved-token' } },
} as unknown as Api

// Opened the way a user opens it, with Edit, so the form seeds on that edge.
function Security() {
  const [editing, setEditing] = useState(false)
  return <SecurityTab api={API} editing={editing} onEditingChange={setEditing} />
}

function openSecurity() {
  const utils = at(<Security />)
  fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
  return utils
}

describe('API authentication', () => {
  it('asks once the saved settings are edited', async () => {
    const { router } = openSecurity()
    const token = await screen.findByDisplayValue('saved-token')
    fireEvent.change(token, { target: { value: 'new-token' } })
    await expectLeaveAsks(router)
  })

  it('leaves an opened but unchanged form without asking', async () => {
    const { router } = openSecurity()
    await screen.findByDisplayValue('saved-token')
    await expectLeavesWithoutAsking(router)
  })

  it('leaves without asking after Cancel', async () => {
    const { router } = openSecurity()
    fireEvent.change(await screen.findByDisplayValue('saved-token'), { target: { value: 'new-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expectLeavesWithoutAsking(router)
  })
})

describe('API credentials', () => {
  beforeEach(() => {
    vi.mocked(apisApi.getCredentials).mockResolvedValue([] as any)
  })

  it('asks while a credential is half filled in', async () => {
    const { router } = at(<CredentialsTab apiId="api-1" apiName="Northwind" />)
    fireEvent.click(screen.getByRole('button', { name: /Add credential/ }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Production key' } })
    await expectLeaveAsks(router)
  })

  it('leaves without asking after Cancel', async () => {
    const { router } = at(<CredentialsTab apiId="api-1" apiName="Northwind" />)
    fireEvent.click(screen.getByRole('button', { name: /Add credential/ }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Production key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expectLeavesWithoutAsking(router)
  })
})
