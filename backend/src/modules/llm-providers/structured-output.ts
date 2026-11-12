import { LlmProviderType } from '../../entities/llm-provider-type';
import type { ChatRequest } from './dto/llm-providers.dto';

/**
 * Structured output (`ChatRequest.responseFormat`): a reply constrained to
 * a JSON schema. Only the APIs below take it in the shape we send; an
 * OpenAI-compatible host that does not would answer 400, so every other
 * provider gets the request without it and the caller's prompt carries
 * the format.
 */
const STRUCTURED_OUTPUT_TYPES = new Set<LlmProviderType>([LlmProviderType.OPENAI, LlmProviderType.AZURE_OPENAI, LlmProviderType.GOOGLE]);

export function supportsStructuredOutput(type: LlmProviderType | string | undefined): boolean {
  return !!type && STRUCTURED_OUTPUT_TYPES.has(type as LlmProviderType);
}

/** `response_format` for a chat-completions body, or undefined. */
export function openAiResponseFormat(request: Pick<ChatRequest, 'responseFormat'>, type: LlmProviderType | string | undefined): Record<string, unknown> | undefined {
  if (!request.responseFormat || !supportsStructuredOutput(type)) return undefined;
  return { type: 'json_schema', json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema, strict: true } };
}

/**
 * Gemini's `responseSchema` is an OpenAPI subset: no `additionalProperties`.
 * The schema without it, with `responseMimeType`, for `generationConfig`.
 */
export function geminiResponseFormat(request: Pick<ChatRequest, 'responseFormat'>, type: LlmProviderType | string | undefined): Record<string, unknown> | undefined {
  if (!request.responseFormat || !supportsStructuredOutput(type)) return undefined;
  const strip = (node: any): any => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'additionalProperties').map(([k, v]) => [k, strip(v)]));
  };
  return { responseMimeType: 'application/json', responseSchema: strip(request.responseFormat.schema) };
}
