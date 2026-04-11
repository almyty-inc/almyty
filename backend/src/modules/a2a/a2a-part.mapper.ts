import type { Part } from './types/a2a-spec.types';

/**
 * Convert A2A Parts into the format expected by agent input:
 *   { text: string; variables?: Record<string, any> }
 *
 * - TextParts are concatenated into `text`
 * - DataParts are merged into `variables`
 * - FileParts are ignored for now (no file upload path in agent input)
 */
export function a2aPartsToAgentInput(parts: Part[]): {
  text: string;
  variables?: Record<string, any>;
} {
  const textChunks: string[] = [];
  let variables: Record<string, any> | undefined;

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        textChunks.push(part.text);
        break;
      case 'data':
        variables = { ...variables, ...part.data };
        break;
      case 'file':
        // Files are not supported as agent input yet
        break;
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

/**
 * Convert agent output (string or object) into A2A Parts.
 */
export function agentOutputToA2AParts(output: any): Part[] {
  if (output === null || output === undefined) {
    return [];
  }

  if (typeof output === 'string') {
    return [{ type: 'text', text: output }];
  }

  if (typeof output === 'object') {
    return [{ type: 'data', data: output }];
  }

  // Fallback: coerce to string
  return [{ type: 'text', text: String(output) }];
}
