// Optional second count: Anthropic's token-counting endpoint, used only when
// ANTHROPIC_API_KEY is set. The tools' share is the count with the tools
// minus the count of the same one-word message without them, so the fixed
// tool-use system prompt Anthropic adds is part of the number (it is part of
// what the model reads whenever tools are present).
import { modelFacingTool } from './tokens.mjs';

const MODEL = process.env.ANTHROPIC_COUNT_MODEL || 'claude-sonnet-4-5';

async function count(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
  if (!res.ok) throw new Error(`count_tokens answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).input_tokens;
}

export const anthropicAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY);
export const anthropicModel = () => MODEL;

/** Tokens a tools array adds to a request, by Anthropic's count; null when no key is set. */
export async function anthropicToolTokens(tools) {
  if (!anthropicAvailable()) return null;
  const tools_ = tools.map((t) => {
    const m = modelFacingTool(t);
    return { name: m.name, description: m.description ?? '', input_schema: m.input_schema };
  });
  const [withTools, without] = await Promise.all([count({ tools: tools_ }), count({})]);
  return withTools - without;
}
