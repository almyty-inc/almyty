/**
 * SDK / npm APIs: the API page shows the package analysis (never "import a
 * description"), and the Create tool form sends a config the backend's
 * SdkCodeAssemblerService can actually run.
 *
 * The form used to send `{ imports: ['X'], call: { method, chain, args:
 * [{ source }] } }`, a shape the assembler does not read (it reads
 * `call.methodPath` and `args: [{ type }]`), and an argument shown as "Tool
 * param" was sent as an empty literal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { buildSdkConfig, assemblePreview } from '@/components/tools/sdk-tool-form'
import { SdkPackagesCard } from '@/components/apis/detail/sdk-packages-card'
import { apisApi } from '@/lib/api'
import type { SdkMap } from '@/types'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))
vi.mock('@/lib/api', () => ({ apisApi: { analyseSdk: vi.fn() } }))
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

const str = { kind: 'string' as const }
const map: SdkMap = {
  packageName: 'greeter-sdk',
  version: '1.0.0',
  exports: [
    {
      name: 'Greeter',
      kind: 'class',
      constructorParams: [
        { name: 'options', required: true, type: { kind: 'object', properties: [{ name: 'prefix', required: false, type: str }] } },
      ],
      methods: [{ name: 'greet', isAsync: true, params: [{ name: 'name', required: true, type: str }] }],
      properties: [{ name: 'math', type: { kind: 'object' }, methods: [{ name: 'add', isAsync: false, params: [{ name: 'a', required: true, type: { kind: 'number' } }, { name: 'b', required: true, type: { kind: 'number' } }] }] }],
    },
    { name: 'shout', kind: 'function', methods: [{ name: 'shout', isAsync: false, params: [{ name: 'text', required: true, type: str }] }] },
  ],
}

describe('buildSdkConfig', () => {
  it('constructs a class and calls its method with untouched args as tool parameters', () => {
    const greeter = map.exports[0]
    const config = buildSdkConfig({
      map,
      exportEntry: greeter,
      methodEntry: { method: greeter.methods![0], chain: [] },
      constructorValues: { options: { source: 'literal', properties: { prefix: { source: 'literal', value: 'Hi' } } } },
      methodArgValues: {},
    })
    expect(config).toEqual({
      packageName: 'greeter-sdk',
      version: '1.0.0',
      imports: [{ name: 'Greeter', isDefault: false }],
      construct: { className: 'Greeter', args: [{ type: 'object', properties: { prefix: { type: 'literal', value: 'Hi' } } }] },
      call: { methodPath: 'greet', args: [{ type: 'parameter', key: 'name' }] },
    })
    expect(assemblePreview(config)).toContain('const result = await client.greet(parameters.name);')
  })

  it('calls a chained method through the property', () => {
    const greeter = map.exports[0]
    const config = buildSdkConfig({
      map,
      exportEntry: greeter,
      methodEntry: { method: greeter.properties![0].methods![0], chain: ['math'] },
      constructorValues: {},
      methodArgValues: { b: { source: 'literal', value: 3 } },
      dataPath: 'value',
    })
    expect(config.construct).toEqual({ className: 'Greeter', args: [] })
    expect(config.call).toEqual({ methodPath: 'math.add', args: [{ type: 'parameter', key: 'a' }, { type: 'literal', value: 3 }] })
    expect(config.responseMapping).toEqual({ dataPath: 'value' })
  })

  it('calls a function export directly, without constructing anything', () => {
    const shout = map.exports[1]
    const config = buildSdkConfig({
      map,
      exportEntry: shout,
      methodEntry: { method: shout.methods![0], chain: [] },
      constructorValues: {},
      methodArgValues: { text: { source: 'parameter', paramName: 'words' } },
    })
    expect(config.construct).toBeUndefined()
    expect(config.imports).toEqual([{ name: 'shout', isDefault: false }])
    expect(config.call).toEqual({ methodPath: 'shout', args: [{ type: 'parameter', key: 'words' }] })
  })
})

describe('SdkPackagesCard', () => {
  beforeEach(() => vi.mocked(apisApi.analyseSdk).mockReset())

  const base = { id: 'api-1', name: 'Greeter', type: 'sdk', dependencies: { 'greeter-sdk': '^1.0.0' } } as any

  it('offers Create a tool once the packages are read', async () => {
    const api = {
      ...base,
      metadata: { sdkAnalysis: { state: 'ready', packages: [{ name: 'greeter-sdk', version: '1.0.0', exports: 2, callables: 3 }] } },
    }
    renderAtRoute(<SdkPackagesCard api={api} apiTools={[]} />, { path: '/apis/:id', url: '/apis/api-1' })
    expect(screen.getByText('2 exports, 3 methods')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Create a tool/ })).toHaveAttribute('href', '/tools/new?type=sdk&api=api-1')
    expect(screen.queryByText(/description/i)).not.toBeInTheDocument()
  })

  it('shows progress while the analysis runs', () => {
    renderAtRoute(<SdkPackagesCard api={{ ...base, metadata: { sdkAnalysis: { state: 'analysing' } } }} apiTools={[]} />, {
      path: '/apis/:id',
      url: '/apis/api-1',
    })
    expect(screen.getByRole('status')).toHaveTextContent(/Installing the packages/)
    expect(screen.getByRole('button', { name: /Analyse again/ })).toBeDisabled()
  })

  it('says why it failed and runs it again', async () => {
    vi.mocked(apisApi.analyseSdk).mockResolvedValue({ jobId: 'j1' })
    const api = { ...base, lastImportError: 'npm ERR! 404 greeter-sdk not found', metadata: { sdkAnalysis: { state: 'failed' } } }
    renderAtRoute(<SdkPackagesCard api={api} apiTools={[]} />, { path: '/apis/:id', url: '/apis/api-1' })
    expect(screen.getByRole('alert')).toHaveTextContent('The analysis failed: npm ERR! 404 greeter-sdk not found')
    expect(screen.queryByRole('link', { name: /Create a tool/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Analyse again/ }))
    await waitFor(() => expect(apisApi.analyseSdk).toHaveBeenCalledWith('api-1'))
  })
})
