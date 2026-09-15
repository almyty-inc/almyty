import { PROVIDER_PROFILES } from './provider-profile';

/**
 * The supported-providers table, generated from the registry.
 *
 * It was maintained by hand and had already drifted: it said 15 providers
 * while the registry held 33, and it still described a node by a name the
 * UI stopped using. A table nobody can keep current is worse than no
 * table, because a reader trusts it.
 *
 * Generated as a fragment between markers rather than as a whole file, so
 * the prose around it stays hand-written where a person should be writing
 * it. See `providers-doc.spec.ts` for the guard that fails when the
 * checked-in fragment no longer matches the registry.
 */
export const DOC_START = '<!-- generated:providers start -->';
export const DOC_END = '<!-- generated:providers end -->';

const PROTOCOL_NAMES: Record<string, string> = {
  chat_completions: 'OpenAI chat completions',
  responses: 'OpenAI responses',
  anthropic_messages: 'Anthropic messages',
  gemini_generate_content: 'Gemini generateContent',
  bedrock_converse: 'Bedrock Converse',
  cohere_v2: 'Cohere v2',
  dashscope_native: 'DashScope native',
  embeddings: 'embeddings',
  rerank: 'rerank',
};

function apiFormats(profile: (typeof PROVIDER_PROFILES)[number]): string {
  const preferred = profile.protocols.find((p) => p.preferred) ?? profile.protocols[0];
  const rest = profile.protocols.filter((p) => p !== preferred);
  const name = (key: string) => PROTOCOL_NAMES[key] ?? key;
  // The preferred one first and marked, because which format a vendor is
  // called through is the thing that decides what survives the call.
  return [`${name(preferred.protocol)} (preferred)`, ...rest.map((p) => name(p.protocol))].join(', ');
}

/** The table body, ready to drop between the markers. */
export function providersTable(): string {
  const rows = [...PROVIDER_PROFILES]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((p) => `| ${p.displayName} | \`${p.key}\` | ${apiFormats(p)} | ${p.blurb} |`);

  return [
    `almyty speaks to ${PROVIDER_PROFILES.length} providers out of the box, plus any`,
    'OpenAI-compatible endpoint you point it at.',
    '',
    '| Provider | Type | API format | Serves |',
    '|----------|------|------------|--------|',
    ...rows,
  ].join('\n');
}

/** The file content with the fragment replaced. Throws if the markers are missing. */
export function withGeneratedTable(markdown: string): string {
  const start = markdown.indexOf(DOC_START);
  const end = markdown.indexOf(DOC_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`The generated-providers markers are missing or out of order: ${DOC_START} ... ${DOC_END}`);
  }
  return `${markdown.slice(0, start + DOC_START.length)}\n\n${providersTable()}\n\n${markdown.slice(end)}`;
}
