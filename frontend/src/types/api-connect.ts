/**
 * Connecting an API from its description (POST /apis/import) and its one
 * key (/apis/:id/key). Mirrors backend/src/modules/apis/api-connect.service.ts
 * and api-key.service.ts.
 */
import type { Api, ApiType } from './index'

export type ApiKeyType = 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2'

export interface DetectedOAuth2 {
  flow: 'authorization_code' | 'client_credentials'
  authorizationUrl?: string
  tokenUrl: string
  scopes: string[]
}

export interface DetectedAuth {
  type: ApiKeyType
  headerName?: string
  location?: 'header' | 'query'
  oauth2?: DetectedOAuth2
}

export interface ConnectApiInput {
  url?: string
  content?: string
  name?: string
  baseUrl?: string
  authType?: ApiKeyType
  generateTools?: boolean
  visibility?: 'org' | 'team' | 'private'
  teamId?: string | null
}

export interface ConnectApiResult {
  api: Api
  jobId: string
  detected: {
    type: ApiType
    format: 'openapi3' | 'swagger2' | 'graphql-sdl' | 'graphql-introspection' | 'wsdl' | 'proto'
    name: string | null
    version: string | null
    description: string | null
    baseUrl: string | null
    auth: DetectedAuth
  }
  needs: { key: boolean; address: boolean }
}

export interface ApiKeyView {
  type: ApiKeyType
  headerName: string | null
  location: 'header' | 'query' | null
  oauth2: { flow: string | null; authorizationUrl: string | null; tokenUrl: string | null; scopes: string[] } | null
  source: 'key' | 'oauth' | 'connection' | null
  credential: { id: string; name: string; type: string; lastUsedAt: string | null; updatedAt: string | null } | null
  connection: { id: string; name: string; accountLabel: string | null; connectorKey: string | null } | null
}

export interface SetApiKeyInput {
  type?: ApiKeyType
  key?: string
  username?: string
  headerName?: string
  location?: 'header' | 'query'
  connectionId?: string
}
