/**
 * Tool integrity verification.
 *
 * Hashes tool definitions at creation time and verifies them at execution
 * time to detect tampering (rug pull attacks, unauthorized modifications).
 */

import { createHash } from 'crypto';

export interface ToolDefinitionHash {
  hash: string;
  algorithm: string;
  fields: string[];
}

/**
 * Compute a deterministic hash of a tool's definition.
 * Includes name, description, parameters, code, and execution method.
 */
export function computeToolHash(tool: {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  code?: string | null;
  executionMethod?: string | null;
}): ToolDefinitionHash {
  const fields = ['name', 'description', 'parameters', 'code', 'executionMethod'];

  // Build a deterministic string from the tool definition
  const canonical = JSON.stringify({
    name: tool.name || '',
    description: tool.description || '',
    parameters: tool.parameters ? sortObjectKeys(tool.parameters) : {},
    code: tool.code || '',
    executionMethod: tool.executionMethod || '',
  });

  const hash = createHash('sha256').update(canonical).digest('hex');

  return {
    hash,
    algorithm: 'sha256',
    fields,
  };
}

/**
 * Verify a tool's current definition matches its stored hash.
 */
export function verifyToolIntegrity(
  tool: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
    code?: string | null;
    executionMethod?: string | null;
  },
  storedHash: string,
): { valid: boolean; currentHash: string } {
  const { hash: currentHash } = computeToolHash(tool);
  return {
    valid: currentHash === storedHash,
    currentHash,
  };
}

/**
 * Sort object keys recursively for deterministic JSON serialization.
 */
function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);

  const sorted: Record<string, any> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}
