import type { StreamChunk } from '../llm-providers/dto/llm-providers.dto';

/**
 * Turn one streamed model chunk into run events.
 *
 * A text delta is an `llm.chunk`, as it always was. A provider's
 * certain verdict on what the step is becomes `llm.step_kind`: `text`
 * when the reply is a plain answer, `tool` when it calls tools. It is
 * emitted at most once per step, in stream order, so a consumer that
 * holds a step's chunks until it arrives knows exactly which ones are
 * answer and which were narration ahead of a tool call.
 */
export function emitStreamChunk(
  emit: (type: string, data: Record<string, unknown>) => void,
  step: number,
  chunk: StreamChunk,
): void {
  if (chunk.content) emit('llm.chunk', { step, content: chunk.content });
  if (chunk.stepKind) emit('llm.step_kind', { step, kind: chunk.stepKind });
}