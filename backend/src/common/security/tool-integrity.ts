/**
 * Tool integrity verification.
 *
 * Hashes tool definitions at creation time and verifies them at execution
 * time to detect tampering (rug pull attacks, unauthorized modifications).
 *
 * The hash covers the name, description, parameters, code, execution method
 * and the tool's side-effect class (docs/design/code-mode.md, part A): a
 * class changed outside the tool's own update path (a tool dropped from
 * `destructive` to `read`, so code mode would no longer stage it) fails
 * verification like any other edit. The class is the effective one,
 * computed from the same columns the tool is classified from, so a hash
 * stamped before the entity's classify hook runs matches the stored row.
 */

import { createHash } from 'crypto';

import { ClassifiableTool, toolClass } from '../../modules/tools/tool-side-effect';

export interface ToolDefinitionHash {
  hash: string;
  algorithm: string;
  fields: string[];
}

export interface HashableTool extends ClassifiableTool {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  code?: string | null;
  executionMethod?: string | null;
}

/**
 * Compute a deterministic hash of a tool's definition.
 * Includes name, description, parameters, code, execution method and side-effect class.
 */
export function computeToolHash(tool: HashableTool): ToolDefinitionHash {
  const fields = ['name', 'description', 'parameters', 'code', 'executionMethod', 'sideEffect'];

  // Build a deterministic string from the tool definition
  const canonical = JSON.stringify({
    name: tool.name || '',
    description: tool.description || '',
    parameters: tool.parameters ? sortObjectKeys(tool.parameters) : {},
    code: tool.code || '',
    executionMethod: tool.executionMethod || '',
    sideEffect: toolClass(tool).sideEffect,
  });

  return { hash: createHash('sha256').update(canonical).digest('hex'), algorithm: 'sha256', fields };
}

/**
 * The hash before the side-effect class was part of it. Only the migration
 * that re-stamps existing hashes uses it (1750813799000-ToolSideEffectClass):
 * a row whose stored hash still matches this is re-stamped with the current
 * hash; one that does not stays refused, as it was.
 */
export function computeToolHashWithoutClass(tool: HashableTool): string {
  const canonical = JSON.stringify({
    name: tool.name || '',
    description: tool.description || '',
    parameters: tool.parameters ? sortObjectKeys(tool.parameters) : {},
    code: tool.code || '',
    executionMethod: tool.executionMethod || '',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Verify a tool's current definition matches its stored hash.
 */
export function verifyToolIntegrity(tool: HashableTool, storedHash: string): { valid: boolean; currentHash: string } {
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
