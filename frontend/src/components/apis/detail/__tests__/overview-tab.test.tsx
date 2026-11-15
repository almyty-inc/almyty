/**
 * The API page's overview. Two things the journey audit found here:
 * "Tools generated N" opened /tools with every tool of the organization,
 * and "Test connection" showed a healthy API (Open-Meteo answers 400 on its
 * bare address) as a red "Failed" under raw `{"success":false,...}` JSON.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { render } from '@/test/setup'
import { OverviewTab, apiToolsPath } from '../overview-tab'
import { apisApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  apisApi: { testConnection: vi.fn(), generateTools: vi.fn() },
}))

const API = { id: 'api-7', name: 'Open-Meteo Weather Forecast API', type: 'openapi', baseUrl: 'https://api.open-meteo.com', schemas: [] } as any
const TOOL = { id: 'tool-1', name: 'get_v1_forecast', metadata: { sourceApi: { id: 'api-7' } } } as any

function renderOverview() {
  return render(
    <OverviewTab
      api={API}
      operations={[{ id: 'op-1' } as any]}
      apiTools={[TOOL]}
      onOpenSchemaViewer={vi.fn()}
      onOpenAuthConfig={vi.fn()}
      onOpenSchemaImport={vi.fn()}
    />,
  )
}

describe('OverviewTab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('links "Tools generated" to this API\'s tools only', () => {
    renderOverview()

    const link = screen.getByRole('link', { name: /Show the 1 tool of Open-Meteo/ })
    expect(link.getAttribute('href')).toBe(apiToolsPath(API))
    const url = new URL(link.getAttribute('href')!, 'https://app.example.com')
    expect(url.pathname).toBe('/tools')
    expect(url.searchParams.get('apiId')).toBe('api-7')
    expect(url.searchParams.get('apiName')).toBe('Open-Meteo Weather Forecast API')
  })

  it('shows a host that answers 400 on its address as reachable, in words', async () => {
    vi.mocked(apisApi.testConnection).mockResolvedValue({
      success: true,
      statusCode: 400,
      responseTime: 81,
      message: 'api.open-meteo.com is reachable: it answered in 81 ms with HTTP 400 on its main address. That is normal for an API that only answers on its own paths.',
    })
    renderOverview()

    fireEvent.click(screen.getByRole('button', { name: /Test connection/ }))

    const message = await screen.findByTestId('connection-test-message')
    expect(message).toHaveTextContent('api.open-meteo.com is reachable')
    expect(screen.getByText('Reachable')).toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/"success"|statusCode|[{}]/)
  })

  it('shows a failed test as its sentence, never as JSON', async () => {
    vi.mocked(apisApi.testConnection).mockResolvedValue({
      success: false,
      error: 'Could not reach api.example.com: the connection was refused',
      message: 'Could not reach api.example.com: the connection was refused',
    })
    renderOverview()

    fireEvent.click(screen.getByRole('button', { name: /Test connection/ }))

    const message = await screen.findByTestId('connection-test-message')
    expect(message).toHaveTextContent('Could not reach api.example.com')
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/"success"|[{}]/)
  })
})
