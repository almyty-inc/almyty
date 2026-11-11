// Token counting for the benchmark. One tokenizer, o200k_base (the encoding
// of OpenAI's GPT-4o/4.1/o-series models), from js-tiktoken's bundled ranks,
// so a count needs no network and no API key. Other model families tokenize
// differently; see README.md.
import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';

export const TOKENIZER = 'o200k_base';

let encoder;
function enc() {
  encoder ??= new Tiktoken(o200k_base);
  return encoder;
}

/** Tokens in one string. */
export function countTokens(text) {
  if (typeof text !== 'string') throw new TypeError('countTokens takes a string');
  return text.length === 0 ? 0 : enc().encode(text).length;
}

/**
 * A tool as a client hands it to a model: name, description and the input
 * JSON Schema. Title, annotations, icons and outputSchema stay with the
 * client (no mainstream client sends them to the model), so they are left
 * out of the count.
 */
export function modelFacingTool(tool) {
  const out = { name: tool.name };
  if (tool.description) out.description = tool.description;
  out.input_schema = tool.inputSchema ?? tool.input_schema ?? tool.parameters ?? { type: 'object', properties: {} };
  return out;
}

/** Compact JSON of a tools array as the model sees it. */
export function toolsText(tools) {
  return JSON.stringify(tools.map(modelFacingTool));
}

/** Tokens of a tools array as the model sees it. */
export function countTools(tools) {
  return countTokens(toolsText(tools));
}

/** A tool call the model emits, as text: its name and arguments. */
export function callText(name, args) {
  return JSON.stringify({ name, arguments: args ?? {} });
}

/**
 * The context a task builds up, turn by turn.
 *
 * `initial` is what is in context before the first turn (the tool
 * definitions). Each step is one model turn: the model reads the context,
 * emits a call (`call` tokens), and the result (`result` tokens) is appended.
 * The last step's result is the task's answer and is the same whichever way
 * the tools were exposed, so it is left out (pass `result: 0` or omit it).
 *
 * Returns the context the model read at each turn, the context at the final
 * call, and the input tokens summed over every turn (what an uncached API
 * bills, since each turn re-sends the conversation so far).
 */
export function accumulate(initial, steps) {
  if (!Number.isInteger(initial) || initial < 0) throw new TypeError('initial must be a non-negative integer');
  const perTurn = [];
  let context = initial;
  let emitted = 0;
  steps.forEach((step, i) => {
    perTurn.push(context);
    const call = step.call ?? 0;
    const result = i === steps.length - 1 ? 0 : step.result ?? 0;
    emitted += call;
    context += call + result;
  });
  return {
    turns: steps.length,
    perTurnInput: perTurn,
    finalContext: context,
    cumulativeInput: perTurn.reduce((a, b) => a + b, 0),
    outputTokens: emitted,
  };
}
