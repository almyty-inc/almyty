import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../test/setup'

import {
  WidgetBuilder,
  widgetPlacementSchema,
  widgetPlacementFrom,
  widgetLookFromApp,
  buildPreviewSrcDoc,
  WIDGET_PLACEMENT_DEFAULTS,
} from '../widget-builder'

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    update: vi.fn().mockResolvedValue({}),
  },
  getApiBaseUrl: () => 'https://api.test',
}))

import { gatewaysApi } from '@/lib/api'

const baseGateway = {
  id: '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  name: 'Support widget',
  type: 'chat_widget',
  configuration: { appId: 'app-1', some_channel_key: 'keep-me', widget: { position: 'bottom-left', launcherIcon: 'help', title: 'Old' } },
}

const app = {
  name: 'Northwind',
  branding: { appName: 'Northwind Support', primaryColor: '#22d3ee', greeting: 'Hi there', theme: 'dark' as const },
}

beforeEach(() => {
  vi.mocked(gatewaysApi.update).mockClear()
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

describe('widgetPlacementSchema', () => {
  it('accepts the defaults', () => {
    expect(widgetPlacementSchema.safeParse(WIDGET_PLACEMENT_DEFAULTS).success).toBe(true)
  })

  it('rejects unknown enum values', () => {
    expect(widgetPlacementSchema.safeParse({ position: 'top', launcherIcon: 'spark' }).success).toBe(false)
    expect(widgetPlacementSchema.safeParse({ position: 'bottom-right', launcherIcon: 'rocket' }).success).toBe(false)
  })
})

describe('widgetPlacementFrom', () => {
  it('reads where the widget sits and falls back to the defaults', () => {
    expect(widgetPlacementFrom(baseGateway.configuration)).toEqual({ position: 'bottom-left', launcherIcon: 'help' })
    expect(widgetPlacementFrom(null)).toEqual(WIDGET_PLACEMENT_DEFAULTS)
    expect(widgetPlacementFrom({ widget: { position: 'nowhere' } })).toEqual(WIDGET_PLACEMENT_DEFAULTS)
  })
})

describe('widgetLookFromApp', () => {
  it('takes the look from the app, as the widget-config endpoint does', () => {
    expect(widgetLookFromApp(app)).toEqual({
      primaryColor: '#22d3ee',
      title: 'Northwind Support',
      greeting: 'Hi there',
      theme: 'dark',
      poweredBy: true,
      aiDisclosure: 'You are chatting with an AI assistant.',
    })
  })

  it('falls back to the app name, the default colour, and hides the mark for a white-label app', () => {
    expect(widgetLookFromApp({ name: 'Acme', branding: { whiteLabel: true, aiDisclosure: 'A bot answers.' } })).toMatchObject({
      title: 'Acme',
      primaryColor: '#8b5cf6',
      poweredBy: false,
      aiDisclosure: 'A bot answers.',
    })
  })
})

describe('buildPreviewSrcDoc', () => {
  const cfg = { ...WIDGET_PLACEMENT_DEFAULTS, ...widgetLookFromApp({ name: 'Acme', branding: null }) }

  it('loads the real widget.js and ships the config as inert escaped JSON', () => {
    const doc = buildPreviewSrcDoc('https://api.test/gateways/gw-1/widget.js', cfg)
    expect(doc).toContain('<script src="https://api.test/gateways/gw-1/widget.js">')
    expect(doc).toContain('almyty-preview-config')
    expect(doc).toContain('/widget-config')
    expect(doc).toContain('"primaryColor":"#8b5cf6"')
  })

  it('cannot be broken out of via config strings (script-tag injection)', () => {
    const doc = buildPreviewSrcDoc('https://api.test/gateways/gw-1/widget.js', {
      ...cfg,
      title: 'x</script><script>alert(1)</script>',
      greeting: '<img src=x onerror=alert(1)>',
    })
    expect(doc).not.toContain('</script><script>alert(1)')
    expect(doc).not.toContain('<img src=x')
    // The payload arrives with `<` escaped instead.
    expect(doc).toContain('\\u003c/script>')
    expect(doc).toContain('\\u003cimg src=x')
  })
})

describe('WidgetBuilder', () => {
  it('shows the embed snippet and a live preview in the app look, asking only where it sits', () => {
    const { container } = render(<WidgetBuilder gateway={baseGateway} app={app} />)

    // The look is the app's: nothing here edits it.
    expect(screen.queryByLabelText('Title')).toBeNull()
    expect(screen.queryByLabelText('Primary color')).toBeNull()
    expect(screen.getByText(/come from the app/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Position')).toBeInTheDocument()
    expect(screen.getByLabelText('Launcher icon')).toBeInTheDocument()

    // Embed snippet is the exact one-liner customers paste.
    expect(screen.getByText(`<script src="https://api.test/gateways/${baseGateway.id}/widget.js" async></script>`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy embed snippet' })).toBeInTheDocument()

    const iframe = container.querySelector('iframe[title="Chat widget live preview"]')
    const srcdoc = iframe!.getAttribute('srcdoc') || ''
    expect(srcdoc).toContain(`https://api.test/gateways/${baseGateway.id}/widget.js`)
    expect(srcdoc).toContain('"title":"Northwind Support"')
    expect(srcdoc).toContain('"position":"bottom-left"')
    expect(srcdoc).toContain('You are chatting with an AI assistant.')
  })

  it('saves where it sits by merging into the stored widget block', async () => {
    const user = userEvent.setup()
    render(<WidgetBuilder gateway={{ ...baseGateway, configuration: { ...baseGateway.configuration, widget: { position: 'bottom-right', launcherIcon: 'help', title: 'Old' } } }} app={app} />)

    // Radix Select: open it and pick.
    await user.click(screen.getByLabelText('Position'))
    await user.click(await screen.findByRole('option', { name: 'Bottom left' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(gatewaysApi.update).toHaveBeenCalledTimes(1))
    expect(gatewaysApi.update).toHaveBeenCalledWith(baseGateway.id, {
      configuration: {
        appId: 'app-1',
        some_channel_key: 'keep-me',
        widget: { title: 'Old', position: 'bottom-left', launcherIcon: 'help' },
      },
    })
  })
})
