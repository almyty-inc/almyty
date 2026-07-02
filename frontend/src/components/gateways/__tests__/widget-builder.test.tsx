import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../test/setup'

import {
  WidgetBuilder,
  widgetConfigSchema,
  widgetConfigFromGateway,
  aiDisclosureText,
  buildPreviewSrcDoc,
  WIDGET_CONFIG_FORM_DEFAULTS,
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
  configuration: { aiDisclosure: true, some_channel_key: 'keep-me' },
}

beforeEach(() => {
  vi.mocked(gatewaysApi.update).mockClear()
})

describe('widgetConfigSchema', () => {
  it('accepts the defaults', () => {
    expect(widgetConfigSchema.safeParse(WIDGET_CONFIG_FORM_DEFAULTS).success).toBe(true)
  })

  it('rejects bad hex colors', () => {
    for (const bad of ['red', '#12345g', '8b5cf6', '#1234', 'javascript:alert(1)']) {
      const out = widgetConfigSchema.safeParse({
        ...WIDGET_CONFIG_FORM_DEFAULTS,
        primaryColor: bad,
      })
      expect(out.success).toBe(false)
    }
  })

  it('accepts 3- and 6-digit hex colors', () => {
    for (const good of ['#abc', '#8b5cf6', '#22D3EE']) {
      expect(
        widgetConfigSchema.safeParse({ ...WIDGET_CONFIG_FORM_DEFAULTS, primaryColor: good })
          .success,
      ).toBe(true)
    }
  })

  it('length-caps title and greeting', () => {
    expect(
      widgetConfigSchema.safeParse({ ...WIDGET_CONFIG_FORM_DEFAULTS, title: 't'.repeat(61) })
        .success,
    ).toBe(false)
    expect(
      widgetConfigSchema.safeParse({
        ...WIDGET_CONFIG_FORM_DEFAULTS,
        greeting: 'g'.repeat(301),
      }).success,
    ).toBe(false)
  })

  it('rejects unknown enum values', () => {
    expect(
      widgetConfigSchema.safeParse({ ...WIDGET_CONFIG_FORM_DEFAULTS, position: 'top-left' })
        .success,
    ).toBe(false)
    expect(
      widgetConfigSchema.safeParse({ ...WIDGET_CONFIG_FORM_DEFAULTS, theme: 'sepia' }).success,
    ).toBe(false)
  })
})

describe('widgetConfigFromGateway', () => {
  it('returns defaults when nothing is saved', () => {
    expect(widgetConfigFromGateway(null)).toEqual(WIDGET_CONFIG_FORM_DEFAULTS)
    expect(widgetConfigFromGateway({})).toEqual(WIDGET_CONFIG_FORM_DEFAULTS)
  })

  it('merges saved widget values over the defaults', () => {
    const out = widgetConfigFromGateway({
      widget: { title: 'Northwind', primaryColor: '#123456' },
    })
    expect(out.title).toBe('Northwind')
    expect(out.primaryColor).toBe('#123456')
    expect(out.position).toBe('bottom-right')
  })

  it('falls back to defaults when the saved config is invalid', () => {
    expect(widgetConfigFromGateway({ widget: { primaryColor: 'nope' } })).toEqual(
      WIDGET_CONFIG_FORM_DEFAULTS,
    )
    expect(widgetConfigFromGateway({ widget: 'not-an-object' })).toEqual(
      WIDGET_CONFIG_FORM_DEFAULTS,
    )
  })
})

describe('aiDisclosureText', () => {
  it('passes the channel-level setting through', () => {
    expect(aiDisclosureText(undefined)).toBeNull()
    expect(aiDisclosureText({})).toBeNull()
    expect(aiDisclosureText({ aiDisclosure: false })).toBeNull()
    expect(aiDisclosureText({ aiDisclosure: true })).toBe(
      'You are chatting with an AI assistant.',
    )
    expect(aiDisclosureText({ aiDisclosure: '  Custom note  ' })).toBe('Custom note')
  })
})

describe('buildPreviewSrcDoc', () => {
  const cfg = { ...WIDGET_CONFIG_FORM_DEFAULTS, aiDisclosure: null }

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
  it('renders the form from saved configuration plus embed snippet and live preview', () => {
    const { container } = render(
      <WidgetBuilder
        gateway={{
          ...baseGateway,
          configuration: {
            ...baseGateway.configuration,
            widget: { title: 'Northwind Support', primaryColor: '#22d3ee' },
          },
        }}
      />,
    )

    expect(screen.getByLabelText('Title')).toHaveValue('Northwind Support')
    expect(screen.getByLabelText('Primary color')).toHaveValue('#22d3ee')

    // Embed snippet is the exact one-liner customers paste.
    expect(
      screen.getByText(
        `<script src="https://api.test/gateways/${baseGateway.id}/widget.js" async></script>`,
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy embed snippet' })).toBeInTheDocument()

    // Live preview iframe loads the real widget.js for this gateway.
    const iframe = container.querySelector('iframe[title="Chat widget live preview"]')
    expect(iframe).not.toBeNull()
    const srcdoc = iframe!.getAttribute('srcdoc') || ''
    expect(srcdoc).toContain(`https://api.test/gateways/${baseGateway.id}/widget.js`)
    expect(srcdoc).toContain('"title":"Northwind Support"')

    // Channel aiDisclosure is surfaced (passthrough, edited elsewhere).
    expect(srcdoc).toContain('You are chatting with an AI assistant.')
  })

  it('saves by MERGING the widget key into the existing configuration', async () => {
    const user = userEvent.setup()
    render(<WidgetBuilder gateway={baseGateway} />)

    const title = screen.getByLabelText('Title')
    await user.clear(title)
    await user.type(title, 'Talk to sales')
    await user.click(screen.getByRole('button', { name: 'Save widget' }))

    await waitFor(() => expect(gatewaysApi.update).toHaveBeenCalledTimes(1))
    expect(gatewaysApi.update).toHaveBeenCalledWith(baseGateway.id, {
      configuration: {
        // pre-existing channel config survives the save
        aiDisclosure: true,
        some_channel_key: 'keep-me',
        widget: {
          ...WIDGET_CONFIG_FORM_DEFAULTS,
          title: 'Talk to sales',
        },
      },
    })
  })

  it('rejects a bad hex color client-side and does not call the API', async () => {
    const user = userEvent.setup()
    render(<WidgetBuilder gateway={baseGateway} />)

    const color = screen.getByLabelText('Primary color')
    await user.clear(color)
    await user.type(color, 'magenta')
    await user.click(screen.getByRole('button', { name: 'Save widget' }))

    expect(await screen.findByText('Must be a hex color like #8b5cf6')).toBeInTheDocument()
    expect(gatewaysApi.update).not.toHaveBeenCalled()
  })
})
