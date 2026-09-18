import type { Part } from './types/a2a-spec.types';

/**
 * Part discrimination across A2A versions.
 *
 * A2A changed how a Part announces its content type twice:
 *   - v0.1.x  `{ type: 'text', text }`            (early draft)
 *   - v0.2.x / v0.3.x  `{ kind: 'text', text }`   (JSON-RPC-canonical releases)
 *   - v1.0    `{ text }`                          (proto oneof, member presence)
 *
 * We EMIT only v1.0 (see textPart/dataPart in the types module) but ACCEPT all
 * three on input. Accepting costs a few lines and the alternative is the worst
 * possible failure mode: an unrecognised discriminator yields no text, the run
 * starts with an empty prompt, and the client gets HTTP 200 with a well-formed
 * Task holding an answer to a question that was never asked.
 */
type AnyPart = Part & {
  /** v0.2.x / v0.3.x discriminator. */
  kind?: string;
  /** v0.1.x discriminator. */
  type?: string;
  /** v0.x FilePart payload, nested rather than flattened onto the Part. */
  file?: { name?: string; mimeType?: string; bytes?: string; uri?: string };
};

/** Extract the text of a Part in any A2A dialect, or undefined if it has none. */
export function partText(part: AnyPart | null | undefined): string | undefined {
  if (!part || typeof part !== 'object') return undefined;
  // v1.0 discriminates by member presence; the v0.x discriminators, when
  // present, sit alongside the very same `text` member, so this one check
  // covers all three dialects.
  return typeof part.text === 'string' ? part.text : undefined;
}

/** Extract the structured data of a Part in any A2A dialect. */
export function partData(
  part: AnyPart | null | undefined,
): Record<string, any> | undefined {
  if (!part || typeof part !== 'object') return undefined;
  if (part.data && typeof part.data === 'object' && !Array.isArray(part.data)) {
    return part.data as Record<string, any>;
  }
  return undefined;
}

/** Concatenate every text Part of a message, in any A2A dialect. */
export function partsToText(parts: AnyPart[] | null | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => partText(p))
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
}

/**
 * Convert A2A Parts into the format expected by agent input:
 *   { text: string; variables?: Record<string, any> }
 *
 * - text Parts are concatenated into `text`
 * - data Parts are merged into `variables`
 * - file Parts (v1.0 `url`/`raw`, v0.x nested `file`) are ignored — there is no
 *   file upload path in agent input yet
 */
export function a2aPartsToAgentInput(parts: AnyPart[]): {
  text: string;
  variables?: Record<string, any>;
} {
  const textChunks: string[] = [];
  let variables: Record<string, any> | undefined;

  for (const part of Array.isArray(parts) ? parts : []) {
    const text = partText(part);
    if (typeof text === 'string') {
      textChunks.push(text);
      continue;
    }

    const data = partData(part);
    if (data) {
      variables = { ...variables, ...data };
    }
  }

  const result: { text: string; variables?: Record<string, any> } = {
    text: textChunks.join('\n'),
  };

  if (variables && Object.keys(variables).length > 0) {
    result.variables = variables;
  }

  return result;
}
