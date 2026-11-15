import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '@/test/setup'
import { FormPage } from '@/components/layout/form-page'
import { Form } from '@/components/ui/form'
import { GatewayAuthSection } from '@/components/gateways/detail/gateway-auth-section'
import { gatewaysApi } from '@/lib/api'

/**
 * No form inside a form.
 *
 * The staging gate found that New key > Make key on an agent's A2A channel
 * page made no key: the key form was a <form> nested inside the channel
 * page's FormPage <form>, so its submit also ran the page's. Every form in
 * the app goes through components/ui/form, which renders a <form> only
 * when nothing around it is one. The source scan keeps raw <form> out; the
 * render checks the real section inside a real FormPage.
 */

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    getAuthConfigs: vi.fn(), listApiKeys: vi.fn(), createAuthConfig: vi.fn(), updateAuthConfig: vi.fn(),
    getCompanySignInMetadata: vi.fn(), generateApiKey: vi.fn(), revokeApiKey: vi.fn(),
  },
}))

const SRC = join(__dirname, '..')
const PRIMITIVE = join('components', 'ui', 'form.tsx')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(entry)) out.push(full)
  }
  return out
}
const isTest = (f: string) => /(__tests__|\.test\.|\.spec\.|\/test\/)/.test(f)
/** Drop comments so prose about "<form>" does not count. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

describe('no nested forms', () => {
  it('renders every <form> through components/ui/form', () => {
    const offenders = walk(SRC)
      .filter(f => !isTest(f))
      .map(f => relative(SRC, f))
      .filter(f => f !== PRIMITIVE)
      .filter(f => /<form[\s>]/.test(code(readFileSync(join(SRC, f), 'utf8'))))
    expect(offenders).toEqual([])
  })

  it('renders a real <form> at the top and a group inside it', () => {
    const { container } = render(
      <Form aria-label="Outer" onSubmit={() => {}}>
        <Form aria-label="Inner" onSubmit={() => {}}><input aria-label="Inner field" /></Form>
      </Form>,
    )
    expect(container.querySelectorAll('form')).toHaveLength(1)
    expect(container.querySelectorAll('form form')).toHaveLength(0)
    expect(screen.getByRole('form', { name: 'Inner' }).tagName).toBe('DIV')
  })

  it('submits only the inner form, by its button and by Enter', async () => {
    const user = userEvent.setup()
    const outer = vi.fn((e: any) => e.preventDefault())
    const inner = vi.fn()
    render(
      <Form aria-label="Outer" onSubmit={outer}>
        <Form aria-label="Inner" onSubmit={inner}>
          <input aria-label="Inner field" />
          <button type="submit">Inner save</button>
        </Form>
        <button type="submit">Outer save</button>
      </Form>,
    )
    await user.click(screen.getByRole('button', { name: 'Inner save' }))
    await user.type(screen.getByLabelText('Inner field'), 'x{Enter}')
    expect(inner).toHaveBeenCalledTimes(2)
    expect(outer).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Outer save' }))
    expect(outer).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledTimes(2)
  })

  describe('a gateway key made inside a channel page (FormPage)', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      vi.mocked(gatewaysApi.getAuthConfigs).mockResolvedValue([{ id: 'auth-1', type: 'api_key', isActive: true, configuration: {} }])
      vi.mocked(gatewaysApi.listApiKeys).mockResolvedValue([])
      vi.mocked(gatewaysApi.generateApiKey).mockResolvedValue({ key: 'generated-test-value' })
    })

    const renderPage = (onSave: () => void) => render(
      <FormPage title="A2A" back={{ to: '/agents/a', label: 'Agent' }} onSubmit={onSave}>
        <GatewayAuthSection gatewayId="gw-1" />
      </FormPage>,
    )

    it('Make key makes the key and does not save the page', async () => {
      const user = userEvent.setup()
      const save = vi.fn()
      const { container } = renderPage(save)
      await user.click(await screen.findByRole('button', { name: 'New key' }))
      expect(container.querySelectorAll('form form')).toHaveLength(0)
      await user.type(screen.getByLabelText('Name'), 'Partner')
      await user.click(screen.getByRole('button', { name: 'Make key' }))
      await waitFor(() => expect(gatewaysApi.generateApiKey).toHaveBeenCalledWith('gw-1', { name: 'Partner' }))
      expect(await screen.findByTestId('generated-api-key')).toBeInTheDocument()
      expect(save).not.toHaveBeenCalled()
    })

    it('Enter in the key name makes the key and does not save the page', async () => {
      const user = userEvent.setup()
      const save = vi.fn()
      renderPage(save)
      await user.click(await screen.findByRole('button', { name: 'New key' }))
      await user.type(screen.getByLabelText('Name'), 'Partner{Enter}')
      await waitFor(() => expect(gatewaysApi.generateApiKey).toHaveBeenCalledTimes(1))
      expect(save).not.toHaveBeenCalled()
    })
  })
})
