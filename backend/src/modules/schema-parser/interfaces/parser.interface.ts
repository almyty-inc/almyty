import { Operation } from '../../../entities/operation.entity';
import { Resource } from '../../../entities/resource.entity';

export interface ParsedSchema {
  version: string;
  info: {
    title: string;
    description?: string;
    version: string;
  };
  operations: ParsedOperation[];
  resources: ParsedResource[];
  metadata: Record<string, any>;
}

export interface ParsedOperation {
  operationId: string;
  name: string;
  description?: string;
  method: string;
  endpoint: string;
  parameters: {
    path?: Record<string, any>;
    query?: Record<string, any>;
    header?: Record<string, any>;
    body?: Record<string, any>;
  };
  responses: Record<string, {
    description: string;
    schema?: Record<string, any>;
    examples?: any[];
  }>;
  security?: Array<Record<string, string[]>>;
  tags?: string[];
  deprecated?: boolean;
  metadata?: Record<string, any>;
}

export interface ParsedResource {
  name: string;
  description?: string;
  type: 'model' | 'enum' | 'input' | 'output' | 'interface';
  properties: Record<string, any>;
  schema: Record<string, any>;
  examples?: any[];
}

export interface SchemaParser {
  parseSchema(rawSchema: string, fileName?: string): Promise<ParsedSchema>;
  validateSchema(schema: string): Promise<{ isValid: boolean; errors: string[] }>;
  extractOperations(schema: ParsedSchema): Promise<Operation[]>;
  extractResources(schema: ParsedSchema): Promise<Resource[]>;
}