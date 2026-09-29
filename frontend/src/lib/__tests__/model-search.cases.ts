/**
 * The model search cases, shared by every test of the rule: the matcher
 * itself, the model picker and the Models page all run this table.
 *
 * The provider is named after its default model ("OpenAI · GPT-4o"), which
 * is what made "gpt-4o" list every OpenAI model on staging.
 */
import type { ModelSearchFields } from '../model-search'

export const SEARCH_PROVIDER_OPENAI = { name: 'OpenAI · GPT-4o', type: 'openai' }
export const SEARCH_PROVIDER_ANTHROPIC = { name: 'Anthropic', type: 'anthropic' }

/** In list order: the order a screen shows them in before any search. */
export const SEARCH_CATALOG: ModelSearchFields[] = [
  { id: 'gpt-3.5-turbo', providerName: SEARCH_PROVIDER_OPENAI.name, providerType: SEARCH_PROVIDER_OPENAI.type },
  { id: 'chatgpt-4o-latest', providerName: SEARCH_PROVIDER_OPENAI.name, providerType: SEARCH_PROVIDER_OPENAI.type },
  { id: 'gpt-4o-mini', providerName: SEARCH_PROVIDER_OPENAI.name, providerType: SEARCH_PROVIDER_OPENAI.type },
  { id: 'dall-e-3', providerName: SEARCH_PROVIDER_OPENAI.name, providerType: SEARCH_PROVIDER_OPENAI.type },
  { id: 'gpt-4o', providerName: SEARCH_PROVIDER_OPENAI.name, providerType: SEARCH_PROVIDER_OPENAI.type },
  { id: 'gpt-4o-2024-08-06', providerName: SEARCH_PROVIDER_OPENAI.name, providerType: SEARCH_PROVIDER_OPENAI.type },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', providerName: SEARCH_PROVIDER_ANTHROPIC.name, providerType: SEARCH_PROVIDER_ANTHROPIC.type },
]

const OPENAI_IDS = ['gpt-3.5-turbo', 'chatgpt-4o-latest', 'gpt-4o-mini', 'dall-e-3', 'gpt-4o', 'gpt-4o-2024-08-06']
const GPT_4O = ['gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-08-06', 'chatgpt-4o-latest']

/** query -> the model ids it lists, best first. */
export const SEARCH_CASES: Array<{ query: string; expected: string[]; why: string }> = [
  { query: 'gpt-4o', expected: GPT_4O, why: 'exact id, then prefix, then substring; not every model of the provider named after it' },
  { query: 'gpt4o', expected: GPT_4O, why: 'separators are ignored' },
  { query: 'gpt 4o', expected: GPT_4O, why: 'a space is a separator' },
  { query: 'GPT-4o', expected: GPT_4O, why: 'case is ignored' },
  { query: 'gpt', expected: ['gpt-3.5-turbo', 'gpt-4o-mini', 'gpt-4o', 'gpt-4o-2024-08-06', 'chatgpt-4o-latest'], why: 'prefix hits before substring hits, list order kept within a rank' },
  { query: '4o', expected: ['chatgpt-4o-latest', 'gpt-4o-mini', 'gpt-4o', 'gpt-4o-2024-08-06'], why: 'substring hits keep list order' },
  { query: 'openai', expected: OPENAI_IDS, why: 'no model matches, so the provider name counts' },
  { query: 'anthropic', expected: ['claude-sonnet-5'], why: 'provider fallback, one provider only' },
  { query: 'sonnet', expected: ['claude-sonnet-5'], why: 'display name substring' },
  { query: 'claude sonnet 5', expected: ['claude-sonnet-5'], why: 'exact display name' },
  { query: '', expected: [...OPENAI_IDS, 'claude-sonnet-5'], why: 'no query lists everything in order' },
  { query: '  ', expected: [...OPENAI_IDS, 'claude-sonnet-5'], why: 'blank query lists everything' },
  { query: 'mistral', expected: [], why: 'nothing matches' },
]
