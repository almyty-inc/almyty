/**
 * A GraphQL, SOAP or gRPC tool made on the Create tool page is sent as its
 * protocol's config (graphqlConfig / soapConfig / grpcConfig), the shape
 * the backend's protocol executor runs -- never as generated JavaScript,
 * which the sandbox could not run. The backend half of this contract,
 * create-then-run against real servers, is
 * backend/src/modules/tools/__tests__/custom-protocol-tools-run.spec.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/setup'
import { ToolNewPage } from '@/pages/tool-new'
import { toolsApi } from '@/lib/api'

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => vi.fn() }
})

// CodeMirror does not type in jsdom; a textarea with the editor's label stands in.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void; 'aria-label'?: string }) => (
    <textarea aria-label={rest['aria-label'] ?? 'code editor'} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

vi.mock('@/lib/api', () => ({
  toolsApi: { create: vi.fn() },
  llmProvidersApi: { getAll: vi.fn().mockResolvedValue([]) },
  apisApi: { getAll: vi.fn().mockResolvedValue([]), getSdkMaps: vi.fn().mockResolvedValue({}) },
  credentialsApi: { getAll: vi.fn().mockResolvedValue([]) },
  organizationsApi: { getTeams: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/store/organization', () => {
  const state = { currentOrganization: { id: 'org-1', name: 'Acme' } }
  const useOrganizationStore: any = (selector?: (s: any) => unknown) => (selector ? selector(state) : state)
  useOrganizationStore.getState = () => state
  return { useOrganizationStore }
})

vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))

const PROTO = 'syntax = "proto3";\nservice EchoService { rpc Echo(EchoRequest) returns (EchoResponse); }'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(toolsApi.create).mockResolvedValue({ id: 'tool-1' } as any)
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false) as any
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

async function pickMethod(user: ReturnType<typeof userEvent.setup>, label: string) {
  renderWithProviders(<ToolNewPage />)
  await user.click(screen.getByRole('combobox', { name: 'Execution method' }))
  await user.click(await screen.findByRole('option', { name: label }))
  await user.type(screen.getByLabelText(/Tool name/), 'my_tool')
}

/** Set a field's value in one change (userEvent.type reads `{` as a key descriptor). */
function set(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Create tool' }))
}

describe('Create tool: GraphQL, SOAP and gRPC are saved as their protocol config', () => {
  it('GraphQL sends graphqlConfig with the variables parsed, and no code', async () => {
    const user = userEvent.setup()
    await pickMethod(user, 'GraphQL')
    set(/GraphQL endpoint/, 'https://api.example.com/graphql')
    set('GraphQL query', 'query GetUser($id: Int!) { user(id: $id) { name } }')
    set('GraphQL variables', '{ "id": "{userId}" }')
    await submit(user)

    await waitFor(() => expect(toolsApi.create).toHaveBeenCalled())
    const payload = vi.mocked(toolsApi.create).mock.calls[0][0] as any
    expect(payload).toMatchObject({
      name: 'my_tool',
      type: 'query',
      executionMethod: 'graphql',
      graphqlConfig: {
        endpoint: 'https://api.example.com/graphql',
        query: 'query GetUser($id: Int!) { user(id: $id) { name } }',
        variables: { id: '{userId}' },
      },
    })
    expect(payload.code).toBeUndefined()
  })

  it('GraphQL refuses variables that are not a JSON object, and sends nothing', async () => {
    const user = userEvent.setup()
    await pickMethod(user, 'GraphQL')
    set(/GraphQL endpoint/, 'https://api.example.com/graphql')
    set('GraphQL query', '{ viewer { id } }')
    set('GraphQL variables', '{ id: ')
    await submit(user)

    expect(await screen.findByText('Variables are not valid JSON.')).toBeInTheDocument()
    expect(toolsApi.create).not.toHaveBeenCalled()
  })

  it('SOAP sends soapConfig with the service URL, operation and namespace, and no code', async () => {
    const user = userEvent.setup()
    await pickMethod(user, 'SOAP')
    set(/Service URL/, 'https://www.w3schools.com/xml/tempconvert.asmx')
    set(/^Operation/, 'CelsiusToFahrenheit')
    set(/^Namespace/, 'https://www.w3schools.com/xml/')
    await submit(user)

    await waitFor(() => expect(toolsApi.create).toHaveBeenCalled())
    const payload = vi.mocked(toolsApi.create).mock.calls[0][0] as any
    expect(payload).toMatchObject({
      executionMethod: 'soap',
      soapConfig: {
        endpoint: 'https://www.w3schools.com/xml/tempconvert.asmx',
        operation: 'CelsiusToFahrenheit',
        namespace: 'https://www.w3schools.com/xml/',
      },
    })
    expect(payload.soapConfig.soapAction).toBeUndefined()
    expect(payload.code).toBeUndefined()
  })

  it('gRPC sends grpcConfig carrying the proto, and no code', async () => {
    const user = userEvent.setup()
    await pickMethod(user, 'gRPC')
    set(/Server address/, 'https://grpc.example.com:443')
    set(/^Service/, 'EchoService')
    set(/^Method/, 'Echo')
    set(/^Proto definition/, PROTO)
    await submit(user)

    await waitFor(() => expect(toolsApi.create).toHaveBeenCalled())
    const payload = vi.mocked(toolsApi.create).mock.calls[0][0] as any
    expect(payload).toMatchObject({
      executionMethod: 'grpc',
      grpcConfig: {
        endpoint: 'https://grpc.example.com:443',
        serviceName: 'EchoService',
        methodName: 'Echo',
        protoDefinition: PROTO,
      },
    })
    expect(payload.code).toBeUndefined()
  })

  it('gRPC loads the proto from an uploaded file', async () => {
    const user = userEvent.setup()
    await pickMethod(user, 'gRPC')
    const file = new File([PROTO], 'echo.proto', { type: 'text/plain' })
    await user.upload(screen.getByLabelText(/Upload a .proto file/), file)
    await waitFor(() => expect(screen.getByLabelText(/^Proto definition/)).toHaveValue(PROTO))
  })

  it('gRPC will not save without a proto', async () => {
    const user = userEvent.setup()
    await pickMethod(user, 'gRPC')
    set(/Server address/, 'https://grpc.example.com:443')
    set(/^Service/, 'EchoService')
    set(/^Method/, 'Echo')
    await submit(user)

    expect(await screen.findByText('Paste or upload the .proto that defines the service.')).toBeInTheDocument()
    expect(toolsApi.create).not.toHaveBeenCalled()
  })
})
