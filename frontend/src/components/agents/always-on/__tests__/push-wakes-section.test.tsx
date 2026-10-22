import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/lib/push-wakes', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  pushWakesApi: { list: vi.fn(), options: vi.fn(), create: vi.fn(), update: vi.fn(), resubscribe: vi.fn(), remove: vi.fn() },
}))

import { pushWakesApi, describePushWake, pushWakeHealth, type PushWakeView } from '@/lib/push-wakes'
import { PushWakesSection } from '../push-wakes-section'

const GMAIL = {
  key: 'gmail',
  name: 'Gmail',
  description: 'When a new email arrives in Gmail',
  operations: ['gmail.users.watch'],
  apiHint: 'Connect Gmail under APIs first (see Connect Google).',
  fields: [
    { key: 'topicName', label: 'Pub/Sub topic', placeholder: 'projects/my-project/topics/almyty-gmail', required: true },
    { key: 'pushServiceAccount', label: 'Push service account', required: true },
    { key: 'labelId', label: 'Label', default: 'INBOX' },
  ],
  setup: [
    { text: 'Create a Pub/Sub topic.', consolePath: 'Google Cloud console → Pub/Sub → Topics → Create topic', command: 'gcloud pubsub topics create almyty-gmail' },
    { text: 'Create a push subscription.', command: 'gcloud pubsub subscriptions create x --push-endpoint="{{endpoint.url}}" --push-auth-service-account="{{settings.pushServiceAccount}}"' },
  ],
  spec: { verification: { method: 'oidc_jwt' }, subscribe: {} },
  debounceSeconds: 10,
}
const CALENDAR = { ...GMAIL, key: 'google_calendar', name: 'Google Calendar', description: 'When something changes in Google Calendar', fields: [], setup: [], spec: { verification: { method: 'shared_token' }, subscribe: {} } }

const ROW: PushWakeView = {
  id: 'pw-1',
  name: 'Gmail',
  presetKey: 'gmail',
  apiId: 'api-gmail',
  apiName: 'Gmail API',
  endpointUrl: 'https://api.example.test/push-wakes/pw-1',
  settings: { topicName: 'projects/p/topics/t' },
  verification: 'oidc_jwt',
  debounceSeconds: 10,
  health: { status: 'failed', checkedAt: '2026-10-22T10:00:00.000Z', error: 'Subscribing (gmail.users.watch) failed: HTTP 403: User not authorized to perform this action.' },
  lastPushAt: null,
  pushCount: 0,
  lastWakeAt: null,
  lastRenewedAt: null,
  subscriptionExpiresAt: null,
  renewAt: null,
  setup: [{ text: 'Create a push subscription.', consolePath: 'Pub/Sub → Subscriptions → Create subscription', command: 'gcloud pubsub subscriptions create x --push-endpoint="https://api.example.test/push-wakes/pw-1"' }],
  spec: { subscribe: {} },
}

function renderSection() {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PushWakesSection agentId="a1" />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('push wakes on the always-on page', () => {
  beforeEach(() => {
    vi.mocked(pushWakesApi.list).mockReset().mockResolvedValue([ROW])
    vi.mocked(pushWakesApi.options).mockReset().mockResolvedValue({
      presets: [CALENDAR, GMAIL] as any,
      apis: [
        { id: 'api-gmail', name: 'Gmail API', presets: ['gmail'] },
        { id: 'api-cal', name: 'Calendar API', presets: ['google_calendar'] },
      ],
    })
    vi.mocked(pushWakesApi.create).mockReset().mockResolvedValue({ ...ROW, health: { status: 'valid', checkedAt: null, error: null } })
    vi.mocked(pushWakesApi.resubscribe).mockReset().mockResolvedValue(ROW)
    vi.mocked(pushWakesApi.update).mockReset().mockResolvedValue(ROW)
    notify.success.mockReset()
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
  })

  it('shows each push wake with its health, its error, and its address and setup to copy', async () => {
    renderSection()
    const row = await screen.findByTestId('push-wake-row')
    expect(within(row).getByTestId('connection-health')).toHaveAttribute('data-status', 'failed')
    expect(within(row).getByTestId('push-wake-error')).toHaveTextContent('User not authorized')
    await userEvent.click(within(row).getByRole('button', { name: /Address and setup/ }))
    expect(within(row).getAllByTestId('copy-field-value').map((e) => e.textContent)).toEqual([
      'https://api.example.test/push-wakes/pw-1',
      'gcloud pubsub subscriptions create x --push-endpoint="https://api.example.test/push-wakes/pw-1"',
    ])
    expect(within(row).getByText(/In the console: Pub\/Sub → Subscriptions → Create subscription/)).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: 'Subscribe again' }))
    await waitFor(() => expect(pushWakesApi.resubscribe).toHaveBeenCalledWith('a1', 'pw-1'))
  })

  it('changes the wait before waking in place', async () => {
    renderSection()
    const row = await screen.findByTestId('push-wake-row')
    // Closed, it says how many pushes arrived.
    expect(within(row).getByText(/0 pushes so far/)).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: /Address and setup/ }))
    const wait = within(row).getByLabelText('Wait before waking (seconds)')
    await userEvent.clear(wait)
    await userEvent.type(wait, '30')
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(pushWakesApi.update).toHaveBeenCalledWith('a1', 'pw-1', { debounceSeconds: 30 }))
  })
  it('adds Gmail inline: only connections with its tools, its fields, its setup steps, then saves', async () => {
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Add a service' }))
    await userEvent.click(screen.getByLabelText('Watch'))
    await userEvent.click(await screen.findByRole('option', { name: 'When a new email arrives in Gmail' }))

    // The setup steps are shown before saving, with what is known filled in.
    const add = screen.getByTestId('push-wake-add')
    expect(within(add).getByText(/Google Cloud console → Pub\/Sub → Topics → Create topic/)).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Connection'))
    expect(screen.queryByRole('option', { name: 'Calendar API' })).toBeNull()
    await userEvent.click(await screen.findByRole('option', { name: 'Gmail API' }))

    await userEvent.click(screen.getByRole('button', { name: 'Save and subscribe' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter pub/sub topic.')

    await userEvent.type(screen.getByLabelText('Pub/Sub topic'), 'projects/my-project/topics/almyty-gmail')
    await userEvent.type(screen.getByLabelText('Push service account'), 'almyty-push@my-project.iam.gserviceaccount.com')
    expect(within(add).getAllByTestId('copy-field-value').some((e) => e.textContent?.includes('--push-auth-service-account="almyty-push@my-project.iam.gserviceaccount.com"'))).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Save and subscribe' }))
    await waitFor(() =>
      expect(pushWakesApi.create).toHaveBeenCalledWith('a1', {
        presetKey: 'gmail',
        settings: { labelId: 'INBOX', topicName: 'projects/my-project/topics/almyty-gmail', pushServiceAccount: 'almyty-push@my-project.iam.gserviceaccount.com' },
        apiId: 'api-gmail',
        debounceSeconds: null,
      }),
    )
  })

  it('a custom service: its own description, and the signing key for HMAC', async () => {
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Add a service' }))
    await userEvent.click(screen.getByLabelText('Watch'))
    await userEvent.click(await screen.findByRole('option', { name: 'Another service that pushes changes' }))
    // The starting description only verifies; it calls no tools, so no connection is asked for.
    expect(screen.queryByLabelText('Connection')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Save and subscribe' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the signing key the service gave you.')
    await userEvent.type(screen.getByLabelText('Signing key'), 'whsec_123')
    await userEvent.type(screen.getByLabelText('Name'), 'Orders')
    await userEvent.click(screen.getByRole('button', { name: 'Save and subscribe' }))
    await waitFor(() => expect(pushWakesApi.create).toHaveBeenCalled())
    const [, input] = vi.mocked(pushWakesApi.create).mock.calls[0]
    expect(input).toMatchObject({ name: 'Orders', secret: 'whsec_123', spec: { verification: { method: 'hmac' } } })
    expect(input.apiId).toBeUndefined()
  })
})

describe('push wake helpers', () => {
  it('reads health the way connections show it, and says when it last heard', () => {
    expect(pushWakeHealth(ROW)).toEqual({ status: 'failed', checkedAt: '2026-10-22T10:00:00.000Z', error: ROW.health.error })
    expect(describePushWake(ROW, (s) => s)).toBe('No push yet')
    expect(describePushWake({ ...ROW, lastPushAt: 'p', lastRenewedAt: 'r', renewAt: 'n' }, (s) => s)).toBe('Last push p · subscribed r · renews n')
  })
})
