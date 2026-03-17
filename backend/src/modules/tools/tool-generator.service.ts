import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tool, ToolType, ToolStatus } from '../../entities/tool.entity';
import { ToolVersion } from '../../entities/tool-version.entity';
import { Operation, OperationType } from '../../entities/operation.entity';
import { JsonSchema, JsonSchemaType } from '../../entities/json-schema.entity';
import { Api, ApiType } from '../../entities/api.entity';

import { JsonSchemaTranslatorService } from '../json-schema-translator/json-schema-translator.service';
import { computeToolHash } from '../../common/security/tool-integrity';

export interface ToolGenerationOptions {
  includeOperations?: string[]; // Specific operation IDs to include
  excludeOperations?: string[]; // Operation IDs to exclude
  namePrefix?: string; // Prefix for generated tool names
  defaultTimeout?: number; // Default timeout in milliseconds
  defaultRetries?: number; // Default retry attempts
  categoryIds?: string[]; // Categories to assign to generated tools
}

export interface ToolGenerationResult {
  generatedTools: Tool[];
  skippedOperations: Array<{
    operationId: string;
    reason: string;
  }>;
  errors: Array<{
    operationId: string;
    error: string;
  }>;
  summary: {
    total: number;
    generated: number;
    skipped: number;
    errors: number;
  };
}

@Injectable()
export class ToolGeneratorService {
  private readonly logger = new Logger(ToolGeneratorService.name);

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(ToolVersion)
    private toolVersionRepository: Repository<ToolVersion>,
    @InjectRepository(Operation)
    private operationRepository: Repository<Operation>,
    @InjectRepository(JsonSchema)
    private jsonSchemaRepository: Repository<JsonSchema>,
    private jsonSchemaTranslator: JsonSchemaTranslatorService,
  ) {}

  async generateToolsFromApi(
    api: Api,
    options: ToolGenerationOptions = {}
  ): Promise<ToolGenerationResult> {
    const result: ToolGenerationResult = {
      generatedTools: [],
      skippedOperations: [],
      errors: [],
      summary: { total: 0, generated: 0, skipped: 0, errors: 0 },
    };

    try {
      // Get all operations for the API
      let operations = await this.operationRepository.find({
        where: { apiId: api.id, isActive: true },
        relations: ['resource'],
      });

      // Apply filters
      if (options.includeOperations?.length > 0) {
        operations = operations.filter(op => 
          options.includeOperations!.includes(op.id)
        );
      }

      if (options.excludeOperations?.length > 0) {
        operations = operations.filter(op => 
          !options.excludeOperations!.includes(op.id)
        );
      }

      result.summary.total = operations.length;

      // Process operations in parallel (batches of 10 to avoid overwhelming DB)
      const BATCH_SIZE = 10;
      for (let i = 0; i < operations.length; i += BATCH_SIZE) {
        const batch = operations.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(async (operation) => {
            const existingTool = await this.toolRepository.findOne({
              where: { operationId: operation.id },
            });

            if (existingTool) {
              // Regenerate with updated schemas (input + output in parallel)
              const [inputSchema, outputSchema] = await Promise.all([
                this.generateInputSchemaForOperation(operation, api.type),
                this.generateOutputSchemaForOperation(operation, api.type),
              ]);

              existingTool.parameters = inputSchema ? inputSchema.schema : this.createFallbackParameters(operation);
              existingTool.inputSchemaId = inputSchema?.id;
              existingTool.outputSchemaId = outputSchema?.id;
              existingTool.description = this.generateToolDescription(operation, api);

              // Recompute integrity hash on update
              const { hash } = computeToolHash(existingTool);
              existingTool.definitionHash = hash;

              return this.toolRepository.save(existingTool);
            } else {
              return this.generateToolFromOperation(operation, api, options);
            }
          }),
        );

        for (let j = 0; j < batchResults.length; j++) {
          const br = batchResults[j];
          const operation = batch[j];
          if (br.status === 'fulfilled' && br.value) {
            result.generatedTools.push(br.value);
            result.summary.generated++;
          } else if (br.status === 'fulfilled') {
            result.skippedOperations.push({
              operationId: operation.id,
              reason: 'Failed to generate tool schema',
            });
            result.summary.skipped++;
          } else {
            this.logger.error(`Failed to generate tool for operation ${operation.id}: ${(br.reason as Error).message}`);
            result.errors.push({
              operationId: operation.id,
              error: (br.reason as Error).message,
            });
            result.summary.errors++;
          }
        }
      }

      this.logger.log(
        `Tool generation completed for API ${api.id}: ` +
        `${result.summary.generated} generated, ${result.summary.skipped} skipped, ${result.summary.errors} errors`
      );

      return result;

    } catch (error) {
      this.logger.error(`Failed to generate tools from API: ${error.message}`);
      throw error;
    }
  }

  async generateToolFromOperation(
    operation: Operation,
    api: Api,
    options: ToolGenerationOptions = {}
  ): Promise<Tool | null> {
    try {
      // Generate input schema
      const inputSchema = await this.generateInputSchemaForOperation(operation, api.type);
      
      // Generate output schema  
      const outputSchema = await this.generateOutputSchemaForOperation(operation, api.type);

      // Create tool name
      const toolName = this.generateToolName(operation, options.namePrefix);

      // Determine tool type
      const toolType = this.determineToolType(operation);

      // Create tool parameters from input schema
      const parameters = inputSchema ? inputSchema.schema : this.createFallbackParameters(operation);

      // Create the tool
      const tool = this.toolRepository.create({
        name: toolName,
        description: this.generateToolDescription(operation, api),
        type: toolType,
        status: ToolStatus.DRAFT,
        version: '1.0.0',
        operationId: operation.id,
        inputSchemaId: inputSchema?.id,
        outputSchemaId: outputSchema?.id,
        parameters,
        configuration: {
          timeout: options.defaultTimeout || 30000,
          retries: options.defaultRetries || 3,
          cache: {
            enabled: operation.isReadOperation(),
            ttl: operation.isReadOperation() ? 300 : 0, // 5 minutes for read operations
          },
          rateLimit: {
            requestsPerMinute: 60,
            requestsPerHour: 1000,
          },
        },
        metadata: {
          apiId: api.id,
          apiType: api.type,
          operationMethod: operation.method,
          operationEndpoint: operation.endpoint,
          generatedAt: new Date(),
          generationOptions: options,
        },
      });

      const savedTool = await this.toolRepository.save(tool);

      // Compute and store integrity hash
      const { hash } = computeToolHash(savedTool);
      savedTool.definitionHash = hash;
      await this.toolRepository.save(savedTool);

      // Create initial version
      await this.createToolVersion(savedTool, 'Initial tool generation');

      this.logger.log(`Generated tool '${toolName}' from operation '${operation.name}'`);

      return savedTool;

    } catch (error) {
      this.logger.error(`Failed to generate tool from operation: ${error.message}`);
      return null;
    }
  }

  private async generateInputSchemaForOperation(
    operation: Operation,
    apiType: ApiType
  ): Promise<JsonSchema | null> {
    try {
      // Try to find existing input schema
      let inputSchema = await this.jsonSchemaRepository.findOne({
        where: {
          type: JsonSchemaType.INPUT,
          metadata: { operationId: operation.id } as any,
        },
      });

      // If no existing schema, generate one
      if (!inputSchema) {
        inputSchema = await this.jsonSchemaTranslator.translateOperationToInputSchema(
          operation, 
          apiType
        );

        if (inputSchema) {
          inputSchema = await this.jsonSchemaRepository.save(inputSchema);
        }
      }

      return inputSchema;

    } catch (error) {
      this.logger.warn(`Failed to generate input schema for operation ${operation.id}: ${error.message}`);
      return null;
    }
  }

  private async generateOutputSchemaForOperation(
    operation: Operation,
    apiType: ApiType
  ): Promise<JsonSchema | null> {
    try {
      // Try to find existing output schema
      let outputSchema = await this.jsonSchemaRepository.findOne({
        where: {
          type: JsonSchemaType.OUTPUT,
          metadata: { operationId: operation.id } as any,
        },
      });

      // If no existing schema, generate one
      if (!outputSchema) {
        outputSchema = await this.jsonSchemaTranslator.translateOperationToOutputSchema(
          operation,
          apiType
        );

        if (outputSchema) {
          outputSchema = await this.jsonSchemaRepository.save(outputSchema);
        }
      }

      return outputSchema;

    } catch (error) {
      this.logger.warn(`Failed to generate output schema for operation ${operation.id}: ${error.message}`);
      return null;
    }
  }

  private generateToolName(operation: Operation, prefix?: string): string {
    // Prefer operationId if available (e.g., "getStatusCodes")
    let name = operation.operationId || '';

    if (!name) {
      // Build from method + endpoint path
      const method = (operation.method || 'get').toLowerCase();
      const pathParts = (operation.endpoint || '')
        .split('/')
        .filter(p => p && !p.startsWith('{'))
        .map(p => p.replace(/[^a-zA-Z0-9]/g, ''));

      // Also get path params for context
      const pathParams = (operation.endpoint || '')
        .split('/')
        .filter(p => p.startsWith('{'))
        .map(p => p.replace(/[{}]/g, ''));

      if (pathParts.length > 0) {
        name = `${method}_${pathParts.join('_')}`;
        if (pathParams.length > 0) {
          name += `_by_${pathParams.join('_')}`;
        }
      } else {
        // Fallback to cleaned operation name
        name = operation.name || 'unnamed_operation';
      }
    }

    // Clean up the name
    name = name
      .replace(/([a-z])([A-Z])/g, '$1_$2') // camelCase to snake_case
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase();

    // Add prefix if provided
    if (prefix) {
      name = `${prefix}_${name}`;
    }

    // Truncate to 60 chars max (keeping meaningful suffix)
    if (name.length > 60) {
      name = name.substring(0, 60).replace(/_[^_]*$/, ''); // cut at last underscore before limit
    }

    // Ensure name doesn't start with a number
    if (/^[0-9]/.test(name)) {
      name = `tool_${name}`;
    }

    return name;
  }

  private generateToolDescription(operation: Operation, api: Api): string {
    if (operation.description) {
      return operation.description;
    }
    return `${(operation.method || 'GET').toUpperCase()} ${operation.endpoint || ''} operation on ${api.name}`;
  }

  private determineToolType(operation: Operation): ToolType {
    switch (operation.type) {
      case OperationType.QUERY:
        return ToolType.QUERY;
      case OperationType.MUTATION:
        return ToolType.MUTATION;
      case OperationType.RPC:
        return ToolType.ACTION;
      default:
        return ToolType.FUNCTION;
    }
  }

  private createFallbackParameters(operation: Operation): Record<string, any> {
    const parameters: Record<string, any> = {
      type: 'object',
      properties: {},
      required: [],
    };

    // Try to extract parameters from operation
    if (operation.parameters) {
      // Path parameters
      if (operation.parameters.path) {
        for (const [name, param] of Object.entries(operation.parameters.path)) {
          parameters.properties[name] = {
            type: param.type || 'string',
            description: param.description || `Path parameter: ${name}`,
          };
          if (param.required) {
            parameters.required.push(name);
          }
        }
      }

      // Query parameters
      if (operation.parameters.query) {
        for (const [name, param] of Object.entries(operation.parameters.query)) {
          parameters.properties[name] = {
            type: param.type || 'string',
            description: param.description || `Query parameter: ${name}`,
          };
          if (param.required) {
            parameters.required.push(name);
          }
        }
      }

      // Header parameters
      if (operation.parameters.header) {
        for (const [name, param] of Object.entries(operation.parameters.header)) {
          parameters.properties[name] = {
            type: param.type || 'string',
            description: param.description || `Header parameter: ${name}`,
          };
          if (param.required) {
            parameters.required.push(name);
          }
        }
      }

      // Body parameters
      if (operation.parameters.body && typeof operation.parameters.body === 'object') {
        if (operation.parameters.body.schema) {
          Object.assign(parameters, operation.parameters.body.schema);
        } else {
          parameters.properties['body'] = {
            type: 'object',
            description: 'Request body',
          };
        }
      }
    }

    return parameters;
  }

  private async createToolVersion(tool: Tool, changelog?: string): Promise<ToolVersion> {
    const version = this.toolVersionRepository.create({
      toolId: tool.id,
      version: tool.version,
      definition: {
        name: tool.name,
        description: tool.description,
        type: tool.type,
        parameters: tool.parameters,
        configuration: tool.configuration,
      },
      changelog: changelog || 'Initial version',
    });

    return this.toolVersionRepository.save(version);
  }

  async regenerateToolFromOperation(toolId: string): Promise<Tool> {
    const tool = await this.toolRepository.findOne({
      where: { id: toolId },
      relations: ['operation', 'operation.api'],
    });

    if (!tool || !tool.operation) {
      throw new Error('Tool or operation not found');
    }

    const operation = tool.operation;
    const api = operation.api;

    // Regenerate schemas and parameters
    const inputSchema = await this.generateInputSchemaForOperation(operation, api.type);
    const outputSchema = await this.generateOutputSchemaForOperation(operation, api.type);

    // Update tool
    tool.inputSchemaId = inputSchema?.id;
    tool.outputSchemaId = outputSchema?.id;
    tool.parameters = inputSchema ? inputSchema.schema : this.createFallbackParameters(operation);
    tool.description = this.generateToolDescription(operation, api);

    // Increment version
    const currentVersion = tool.version.split('.').map(Number);
    currentVersion[2]++; // Increment patch version
    tool.version = currentVersion.join('.');

    const updatedTool = await this.toolRepository.save(tool);

    // Create new version record
    await this.createToolVersion(updatedTool, 'Regenerated from operation schema');

    return updatedTool;
  }

  async validateToolParameters(tool: Tool, parameters: Record<string, any>): Promise<{
    isValid: boolean;
    errors: string[];
  }> {
    try {
      if (tool.inputSchema) {
        return tool.inputSchema.validate(parameters);
      }

      // Fallback validation using tool parameters
      const errors: string[] = [];
      
      if (tool.parameters?.required) {
        for (const requiredParam of tool.parameters.required) {
          if (!(requiredParam in parameters)) {
            errors.push(`Missing required parameter: ${requiredParam}`);
          }
        }
      }

      return {
        isValid: errors.length === 0,
        errors,
      };

    } catch (error) {
      return {
        isValid: false,
        errors: [`Validation error: ${error.message}`],
      };
    }
  }
}