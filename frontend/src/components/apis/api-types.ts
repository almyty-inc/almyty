/**
 * The kinds of API "Connect an API" offers, picked first as tiles. Each
 * opens its own form: the ones with a description take it the ways that
 * kind comes (a link, a file, the text itself); an npm package and a plain
 * HTTP API have forms of their own.
 */
import type { DescriptionApiType } from '@/types/api-connect'

export type SourceMode = 'link' | 'file' | 'paste'

export interface DescriptionKind {
  type: DescriptionApiType
  label: string
  /** One line under the tile. */
  hint: string
  /** How this kind can be given, the first one shown first. */
  modes: SourceMode[]
  linkLabel: string
  linkPlaceholder: string
  linkHint?: string
  fileAccept: string
  pasteLabel: string
  pastePlaceholder: string
}

export const DESCRIPTION_KINDS: Record<DescriptionApiType, DescriptionKind> = {
  openapi: {
    type: 'openapi',
    label: 'OpenAPI / Swagger',
    hint: 'A link, a file or the JSON or YAML',
    modes: ['link', 'file', 'paste'],
    linkLabel: 'Link to the description',
    linkPlaceholder: 'https://api.example.com/openapi.json',
    fileAccept: '.json,.yaml,.yml',
    pasteLabel: 'The description',
    pastePlaceholder: 'openapi: 3.0.0',
  },
  graphql: {
    type: 'graphql',
    label: 'GraphQL',
    hint: 'The endpoint, or its schema',
    modes: ['link', 'file', 'paste'],
    linkLabel: 'Endpoint',
    linkPlaceholder: 'https://api.example.com/graphql',
    linkHint: 'almyty asks the endpoint for its schema. A link to a .graphql file works too.',
    fileAccept: '.graphql,.gql,.json',
    pasteLabel: 'The schema',
    pastePlaceholder: 'type Query { ... }',
  },
  soap: {
    type: 'soap',
    label: 'SOAP / WSDL',
    hint: 'A WSDL link or file',
    modes: ['link', 'file'],
    linkLabel: 'Link to the WSDL',
    linkPlaceholder: 'https://api.example.com/service?wsdl',
    fileAccept: '.wsdl,.xml',
    pasteLabel: 'The WSDL',
    pastePlaceholder: '<definitions ...>',
  },
  grpc: {
    type: 'grpc',
    label: 'gRPC / proto',
    hint: 'A .proto file',
    modes: ['file', 'paste'],
    linkLabel: 'Link to the .proto file',
    linkPlaceholder: 'https://example.com/service.proto',
    fileAccept: '.proto,.txt',
    pasteLabel: 'The .proto file',
    pastePlaceholder: 'syntax = "proto3";',
  },
}

export const MODE_LABELS: Record<SourceMode, string> = {
  link: 'Link',
  file: 'File',
  paste: 'Paste',
}

/** The tiles, in order: the four description kinds, then an npm package and plain HTTP. */
export const API_KIND_TILES: Array<{ key: DescriptionApiType | 'sdk' | 'http'; label: string; hint: string; to: string }> = [
  ...(['openapi', 'graphql', 'soap', 'grpc'] as const).map((t) => ({ key: t, label: DESCRIPTION_KINDS[t].label, hint: DESCRIPTION_KINDS[t].hint, to: `/apis/new/${t}` })),
  { key: 'sdk', label: 'SDK / npm', hint: 'Its functions become tools', to: '/apis/new/sdk' },
  { key: 'http', label: 'Manual HTTP', hint: 'An address; tools added by hand', to: '/apis/new/http' },
]

export function isDescriptionApiType(value: string | undefined): value is DescriptionApiType {
  return !!value && value in DESCRIPTION_KINDS
}
