import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { CustomConnectorDialog, EMPTY_CUSTOM_CONNECTOR, buildCustomConnectorBody } from '../custom-connector-dialog'
import { connectorsApi } from '../../../lib/connections-api'

vi.mock('../../../lib/connections-api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/connections-api')>('../../../lib/connections-api')
  return { ...actual, connectorsApi: { list: vi.fn(), create: vi.fn() } }
})

const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))

describe('buildCustomConnectorBody', () => {
  it('rejects a bad key, missing name and a URL without protocol', () => {
    const r = buildCustomConnectorBody({ ...EMPTY_CUSTOM_CONNECTOR, key: 'Bad Key', displayName: ' ', baseUrl: 'models.example.com' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['baseUrl', 'displayName', 'key'])
  })

  it('builds an OpenAI-compatible connector probed at {{baseUrl}}/models', () => {
    const r = buildCustomConnectorBody({ ...EMPTY_CUSTOM_CONNECTOR, key: 'office-vllm', displayName: 'Office vLLM', baseUrl: 'https://models.example.com/v1', description: 'On the office box' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body).toMatchObject({ key: 'office-vllm', kind: 'inference', displayName: 'Office vLLM', description: 'On the office box', validation: { kind: 'http', url: '{{baseUrl}}/models', auth: 'bearer' } })
    const method = r.body.connect[0]
    expect(method.type).toBe('api_key')
    expect(method.schema?.properties?.baseUrl).toMatchObject({ default: 'https://models.example.com/v1' })
    expect(method.schema?.properties?.apiKey).toMatchObject({ 'x-secret': true })
    expect(method.schema?.required).toEqual(['baseUrl', 'apiKey'])
  })

  it('makes the key optional for keyless servers', () => {
    const r = buildCustomConnectorBody({ ...EMPTY_CUSTOM_CONNECTOR, key: 'ollama-box', displayName: 'Ollama', baseUrl: 'http://10.0.0.5:11434/v1', requiresKey: false })
    expect(r.ok && r.body.connect[0].schema?.required).toEqual(['baseUrl'])
  })

  it('builds an MCP connector validated by mcp_initialize with serverUrl', () => {
    const r = buildCustomConnectorBody({ ...EMPTY_CUSTOM_CONNECTOR, kind: 'mcp', key: 'weather-mcp', displayName: 'Weather', baseUrl: 'https://mcp.example.com/mcp' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.validation).toEqual({ kind: 'mcp_initialize' })
    expect(Object.keys(r.body.connect[0].schema?.properties ?? {})).toEqual(['serverUrl', 'apiKey'])
  })

  it('builds an S3 registry connector with the bucket field set', () => {
    const r = buildCustomConnectorBody({ ...EMPTY_CUSTOM_CONNECTOR, kind: 'registry', key: 'minio', displayName: 'MinIO', baseUrl: 'https://minio.example.com' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.validation).toEqual({ kind: 's3_bucket' })
    expect(r.body.connect[0].schema?.required).toEqual(['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'])
  })
})

describe('CustomConnectorDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('posts the connector and reports the new key', async () => {
    vi.mocked(connectorsApi.create).mockResolvedValue({ key: 'office-vllm', kind: 'inference', displayName: 'Office vLLM', connect: [] })
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()
    render(<CustomConnectorDialog open onOpenChange={onOpenChange} onCreated={onCreated} />)

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Office vLLM' } })
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'office-vllm' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://models.example.com/v1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))

    await waitFor(() => expect(connectorsApi.create).toHaveBeenCalledTimes(1))
    expect(vi.mocked(connectorsApi.create).mock.calls[0][0]).toMatchObject({ key: 'office-vllm', kind: 'inference', validation: { kind: 'http' } })
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('office-vllm'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows field errors instead of posting', async () => {
    render(<CustomConnectorDialog open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))
    expect(await screen.findByText('Key is required')).toBeInTheDocument()
    expect(connectorsApi.create).not.toHaveBeenCalled()
  })
})
