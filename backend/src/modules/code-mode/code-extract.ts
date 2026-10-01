/**
 * extract(value, schema) for scripts (docs/design/code-mode.md, part C and
 * decision 11): a model call that turns a value with no declared shape
 * (a tool without an output schema returns `unknown`) into an object that
 * matches a JSON Schema, or throws.
 *
 * The model is the `extractor` role: pinned when the agent names one
 * (`agentConfig.codeMode.extractor`), so it never touches the router;
 * otherwise the organization's routing policy with the cheapest selectable
 * model first. The call is attributed and charged like any other routed
 * call; its cost goes to the run.
 */
import type { RoutingPolicy } from '../model-catalog/routing/model-router';
import { jsonSchema2020CompileError, outputSchemaViolation } from '../mcp/core/output-schema-check';
import type { ExtractFn } from './code-broker';

export interface ExtractChat {
  (
    providerId: string | null,
    request: {
      messages: Array<{ role: 'system' | 'user'; content: string }>;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      routing?: RoutingPolicy;
    },
  ): Promise<{ message?: { content?: string | null }; cost?: number; usage?: { totalTokens?: number } }>;
}

export interface ExtractSettings {
  /** Characters of the value sent to the model (CODE_MODE_EXTRACT_MAX_INPUT, default 50000). */
  maxInputChars: number;
  /** Tokens the model may answer with (CODE_MODE_EXTRACT_MAX_TOKENS, default 2000). */
  maxTokens: number;
}

export function extractSettings(env: Record<string, string | undefined> = process.env): ExtractSettings {
  const int = (name: string, fallback: number) => {
    const n = Number(env[name]);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return { maxInputChars: int('CODE_MODE_EXTRACT_MAX_INPUT', 50_000), maxTokens: int('CODE_MODE_EXTRACT_MAX_TOKENS', 2_000) };
}

const SYSTEM =
  'You turn data into JSON that matches a JSON Schema. Answer with the JSON object only, no prose and no code fences. ' +
  'Use only what the data says; where it says nothing about a field, leave the field out unless the schema requires it.';

/** The first JSON object or array in a model's answer. */
export function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('the model did not answer with JSON');
  }
}

export function buildExtract(input: {
  chat: ExtractChat;
  extractor?: { providerId: string; model?: string } | null;
  /** The organization's default routing policy, used when no extractor is pinned. */
  routing?: RoutingPolicy | null;
  settings?: ExtractSettings;
}): ExtractFn {
  const settings = input.settings ?? extractSettings();
  return async (value, schema) => {
    const compileError = jsonSchema2020CompileError(schema);
    if (compileError) throw new Error(`the schema is not valid JSON Schema: ${compileError}`);
    let data = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    if (data.length > settings.maxInputChars) data = data.slice(0, settings.maxInputChars);
    const pinned = input.extractor?.providerId ? input.extractor : null;
    const response = await input.chat(pinned ? pinned.providerId : null, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Schema:\n${JSON.stringify(schema)}\n\nData:\n${data}` },
      ],
      temperature: 0,
      maxTokens: settings.maxTokens,
      ...(pinned ? (pinned.model ? { model: pinned.model } : {}) : { routing: { ...(input.routing ?? {}), objective: 'cheapest' } }),
    });
    const text = response.message?.content ?? '';
    const parsed = parseJsonAnswer(String(text));
    const violation = outputSchemaViolation(schema, parsed);
    if (violation) throw new Error(`the answer does not match the schema: ${violation}`);
    return { value: parsed, cost: Number(response.cost ?? 0), tokens: Number(response.usage?.totalTokens ?? 0) };
  };
}
