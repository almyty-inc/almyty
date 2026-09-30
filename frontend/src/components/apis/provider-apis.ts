/**
 * Ready-made provider APIs on "Connect an API": a model provider's own
 * API, imported from the OpenAPI description the provider publishes, and
 * called with the key the organization already keeps for that provider.
 *
 * Only providers that publish a usable description are here. Each link is
 * pinned to a commit where the host allows it, so an import reads the same
 * description every time:
 *   - OpenAI: github.com/openai/openai-openapi (MIT), commit a1514fb, the
 *     JSON copy (the YAML one has a block scalar YAML parsers refuse).
 *   - Mistral: github.com/mistralai/platform-docs-public (Apache-2.0),
 *     commit ecac75b.
 *   - Hugging Face: the Hub API description the Hub serves itself
 *     (huggingface.co/.well-known/openapi.json); it has no pinned copy.
 * Anthropic publishes no OpenAPI description, so it has no tile.
 */
export interface ProviderApi {
  key: string
  label: string
  /** One line under the tile. */
  hint: string
  /** Where the OpenAPI description is read from. */
  specUrl: string
  /** The name the new API gets. */
  apiName: string
  /** Services whose credentials call this API, the first one preferred. */
  connectorKeys: string[]
}

export const PROVIDER_APIS: ProviderApi[] = [
  {
    key: 'openai',
    label: 'OpenAI',
    hint: 'Chat, images and files',
    specUrl: 'https://raw.githubusercontent.com/openai/openai-openapi/a1514fbafe294e45d9200b32f1df7511f95492f7/openapi.json',
    apiName: 'OpenAI API',
    connectorKeys: ['openai'],
  },
  {
    key: 'mistral',
    label: 'Mistral',
    hint: 'Chat, agents and files',
    specUrl: 'https://raw.githubusercontent.com/mistralai/platform-docs-public/ecac75b617af32e87a6d59c5d9e39e7029fc35db/openapi.yaml',
    apiName: 'Mistral API',
    connectorKeys: ['mistral'],
  },
  {
    key: 'huggingface',
    label: 'Hugging Face Hub',
    hint: 'Models, datasets and Spaces',
    specUrl: 'https://huggingface.co/.well-known/openapi.json',
    apiName: 'Hugging Face Hub API',
    connectorKeys: ['huggingface', 'registry-huggingface'],
  },
]

export function providerApi(key: string | undefined): ProviderApi | null {
  return PROVIDER_APIS.find((p) => p.key === key) ?? null
}

export function providerApiPath(key: string): string {
  return `/apis/new/provider/${key}`
}
