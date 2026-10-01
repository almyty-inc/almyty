/**
 * tools/protocol-config -- what the Create tool page saves for a GraphQL,
 * SOAP or gRPC tool.
 *
 * Each is stored as its protocol's config (`graphqlConfig`, `soapConfig`,
 * `grpcConfig`), the shape the backend's protocol executor runs, and the
 * same one the backend checks on save (backend/src/modules/tools/
 * protocol-tool-config.ts). The page used to generate JavaScript for these
 * instead, which the sandbox could not run.
 */

export type ProtocolMethod = 'graphql' | 'soap' | 'grpc'

export interface GraphqlFormState {
  endpoint: string
  query: string
  /** JSON text: `{ "variable": "{param}" }`, or empty. */
  variables: string
}

export interface SoapFormState {
  endpoint: string
  operation: string
  namespace: string
  soapAction: string
}

export interface GrpcFormState {
  endpoint: string
  serviceName: string
  methodName: string
  protoDefinition: string
}

export interface ProtocolFormState {
  graphqlConfig: GraphqlFormState
  soapConfig: SoapFormState
  grpcConfig: GrpcFormState
}

export function isProtocolMethod(method: string): method is ProtocolMethod {
  return method === 'graphql' || method === 'soap' || method === 'grpc'
}

function urlProblem(value: string): string | undefined {
  const v = value.trim()
  if (!v) return 'Required.'
  if (!/^https?:\/\/\S+$/i.test(v)) return 'Start with https:// (or http:// for a server without TLS).'
  return undefined
}

function parseVariables(text: string): { value?: Record<string, unknown>; problem?: string } {
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { problem: 'Variables must be a JSON object, e.g. { "id": "{userId}" }.' }
    }
    return { value }
  } catch {
    return { problem: 'Variables are not valid JSON.' }
  }
}

/** Field id -> message for every required or malformed field; empty when the section is complete. */
export function protocolProblems(method: string, state: ProtocolFormState): Record<string, string> {
  const problems: Record<string, string> = {}
  const add = (id: string, message: string | undefined) => {
    if (message) problems[id] = message
  }
  if (method === 'graphql') {
    add('graphql-endpoint', urlProblem(state.graphqlConfig.endpoint))
    if (!state.graphqlConfig.query.trim()) add('graphql-query', 'Write the query or mutation the tool runs.')
    add('graphql-variables', parseVariables(state.graphqlConfig.variables).problem)
  } else if (method === 'soap') {
    add('soap-endpoint', urlProblem(state.soapConfig.endpoint))
    if (!state.soapConfig.operation.trim()) add('soap-operation', 'Required.')
  } else if (method === 'grpc') {
    add('grpc-endpoint', urlProblem(state.grpcConfig.endpoint))
    if (!state.grpcConfig.serviceName.trim()) add('grpc-service', 'Required.')
    if (!state.grpcConfig.methodName.trim()) add('grpc-method', 'Required.')
    if (!state.grpcConfig.protoDefinition.trim()) {
      add('grpc-proto', 'Paste or upload the .proto that defines the service.')
    }
  }
  return problems
}

/** The create payload's protocol config. Call only once protocolProblems is empty. */
export function protocolConfigPayload(method: ProtocolMethod, state: ProtocolFormState): Record<string, unknown> {
  if (method === 'graphql') {
    const { value: variables } = parseVariables(state.graphqlConfig.variables)
    return {
      graphqlConfig: {
        endpoint: state.graphqlConfig.endpoint.trim(),
        query: state.graphqlConfig.query,
        ...(variables ? { variables } : {}),
      },
    }
  }
  if (method === 'soap') {
    return {
      soapConfig: {
        endpoint: state.soapConfig.endpoint.trim(),
        operation: state.soapConfig.operation.trim(),
        namespace: state.soapConfig.namespace.trim(),
        ...(state.soapConfig.soapAction.trim() ? { soapAction: state.soapConfig.soapAction.trim() } : {}),
      },
    }
  }
  return {
    grpcConfig: {
      endpoint: state.grpcConfig.endpoint.trim(),
      serviceName: state.grpcConfig.serviceName.trim(),
      methodName: state.grpcConfig.methodName.trim(),
      protoDefinition: state.grpcConfig.protoDefinition,
    },
  }
}
