import { BadRequestException } from '@nestjs/common';

import { AgentPipeline } from '../../entities/agent.entity';

/** Error classification for pipeline failures. */
export enum ExecutionErrorType {
  TIMEOUT = 'TIMEOUT',
  LLM_ERROR = 'LLM_ERROR',
  TOOL_ERROR = 'TOOL_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  NESTING_EXCEEDED = 'NESTING_EXCEEDED',
}

/** Input size limits — shared with the engine. */
export const MAX_INPUT_SIZE_BYTES = 100 * 1024;
export const MAX_PIPELINE_NODES = 100;
export const MAX_PIPELINE_EDGES = 500;
export const MAX_NESTING_DEPTH = 10;

/** Regex matching ASCII C0 control characters except tab, newline, carriage return. */
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export interface ValidateInputOptions {
  nestingDepth?: number;
  maxNestingDepth?: number;
}

export function validateInput(input: any, internalOptions?: ValidateInputOptions): void {
  if (
    internalOptions?.nestingDepth !== undefined &&
    internalOptions.nestingDepth > MAX_NESTING_DEPTH
  ) {
    throw new BadRequestException(
      `Nesting depth (${internalOptions.nestingDepth}) exceeds maximum allowed (${MAX_NESTING_DEPTH})`,
    );
  }

  if (input === undefined || input === null) {
    return;
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException(
      'Execution input must be a plain object (not an array, string, or primitive)',
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch (err: any) {
    throw new BadRequestException(`Execution input could not be serialized: ${err.message}`);
  }
  if (serialized.length > MAX_INPUT_SIZE_BYTES) {
    throw new BadRequestException(
      `Execution input size (${serialized.length} bytes) exceeds maximum allowed (${MAX_INPUT_SIZE_BYTES} bytes)`,
    );
  }

  sanitizeObject(input);
}

export function validatePipelineSize(pipeline: AgentPipeline): void {
  if (pipeline.nodes.length > MAX_PIPELINE_NODES) {
    throw new BadRequestException(
      `Pipeline has ${pipeline.nodes.length} nodes, exceeding maximum of ${MAX_PIPELINE_NODES}`,
    );
  }

  if (pipeline.edges.length > MAX_PIPELINE_EDGES) {
    throw new BadRequestException(
      `Pipeline has ${pipeline.edges.length} edges, exceeding maximum of ${MAX_PIPELINE_EDGES}`,
    );
  }
}

/**
 * Recursively strip control characters from all string values in an object.
 * Mutates the object in place.
 */
export function sanitizeObject(obj: any): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== 'object') return;

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'string') {
      obj[key] = value.replace(CONTROL_CHAR_REGEX, '');
    } else if (typeof value === 'object' && value !== null) {
      sanitizeObject(value);
    }
  }
}

export function classifyNodeError(err: any): ExecutionErrorType {
  const message = (err.message || '').toLowerCase();

  if (message.includes('timeout') || message.includes('timed out')) {
    return ExecutionErrorType.TIMEOUT;
  }
  if (message.includes('budget') || message.includes('budget limit')) {
    return ExecutionErrorType.BUDGET_EXCEEDED;
  }
  if (message.includes('nesting depth')) {
    return ExecutionErrorType.NESTING_EXCEEDED;
  }
  if (
    message.includes('llm') ||
    message.includes('provider') ||
    message.includes('model') ||
    message.includes('rate limit') ||
    message.includes('429')
  ) {
    return ExecutionErrorType.LLM_ERROR;
  }
  if (message.includes('tool') || message.includes('execution failed')) {
    return ExecutionErrorType.TOOL_ERROR;
  }
  return ExecutionErrorType.VALIDATION_ERROR;
}

export function classifiedError(message: string, type: ExecutionErrorType): Error {
  const err = new BadRequestException(message);
  (err as any).errorType = type;
  return err;
}
