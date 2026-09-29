/**
 * The gateway page's in-place editors (widget look, channel credentials)
 * ask before a navigation throws away a change they
 * have not saved, and leave quietly when nothing differs from what is
 * stored.
 */
import { describe, it, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { WidgetBuilder } from '../widget-builder'
import { ChannelConfigForm } from '../detail/channel-config-form'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  gatewaysApi: { update: vi.fn().mockResolvedValue({}) },
  getApiBaseUrl: () => 'https://api.test',
}))
vi.mock('@/lib/connections-api', () => ({
  connectionsApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

const at = (el: JSX.Element) => renderAtRoute(el, { path: '/gateways/gw-1', paths: ['/elsewhere'] })

describe('widget builder', () => {
  const gateway = { id: 'gw-1', name: 'Support widget', type: 'chat_widget', configuration: { widget: { title: 'Support' } } }

  it('asks once the widget is restyled and not saved', async () => {
    const { router } = at(<WidgetBuilder gateway={gateway as any} />)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Help desk' } })
    await expectLeaveAsks(router)
  })

  it('leaves the saved look without asking', async () => {
    const { router } = at(<WidgetBuilder gateway={gateway as any} />)
    await expectLeavesWithoutAsking(router)
  })
})

describe('channel credentials', () => {
  const gateway = { id: 'gw-1', type: 'slack', configuration: {} }
  const form = () => (
    <ChannelConfigForm gateway={gateway} type="slack" onSave={vi.fn()} onTestConnection={vi.fn()} />
  )

  it('asks while a token is typed and not saved', async () => {
    const { router } = at(form())
    fireEvent.change(screen.getByLabelText(/Bot token/i), { target: { value: 'xoxb-typed' } })
    await expectLeaveAsks(router)
  })

  it('leaves empty fields without asking', async () => {
    const { router } = at(form())
    await expectLeavesWithoutAsking(router)
  })
})
