import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JSONSchema7 } from 'json-schema';

import { JsonSchema, JsonSchemaType } from '../../entities/json-schema.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Api, ApiType } from '../../entities/api.entity';
import {
  normalizePropertyToJsonSchema,
  translateOpenAPIOperationInput,
  translateOpenAPIOperationOutput,
  translateGraphQLOperationInput,
  translateGraphQLOperationOutput,
  translateSOAPOperationInput,
  translateSOAPOperationOutput,
  translateProtobufOperationInput,
  translateProtobufOperationOutput,
} from './protocol-translators.helper';

@Injectable()
export class JsonSchemaTranslatorService {
  private readonly logger = new Logger(JsonSchemaTranslatorService.name);

  constructor(
    @InjectRepository(JsonSchema)
    private jsonSchemaRepository: Repository<JsonSchema>,
    @InjectRepository(ApiSchema)
    private apiSchemaRepository: Repository<ApiSchema>,
    @InjectRepository(Operation)
    private operationRepository: Repository<Operation>,
    @InjectRepository(Resource)
    private resourceRepository: Repository<Resource>,
  ) {}

  async translateApiSchemaToJsonSchemas(apiSchema: ApiSchema): Promise<JsonSchema[]> {
    const translatedSchemas: JsonSchema[] = [];
    const api = apiSchema.api;

    try {
      // Get all operations and resources for this API
      const operations = await this.operationRepository.find({
        where: { apiId: api.id },
      });

      const resources = await this.resourceRepository.find({
        where: { apiId: api.id },
      });

      // Translate operations to JSON schemas
      for (const operation of operations) {
        const inputSchema = await this.translateOperationToInputSchema(operation, api.type);
        const outputSchema = await this.translateOperationToOutputSchema(operation, api.type);

        if (inputSchema) {
          translatedSchemas.push(inputSchema);
        }
        if (outputSchema) {
          translatedSchemas.push(outputSchema);
        }
      }

      // Translate resources to JSON schemas
      for (const resource of resources) {
        const resourceSchema = await this.translateResourceToJsonSchema(resource, api.type);
        if (resourceSchema) {
          translatedSchemas.push(resourceSchema);
        }
      }

      // Save all translated schemas
      return this.jsonSchemaRepository.save(translatedSchemas);

    } catch (error) {
      this.logger.error(`Failed to translate API schema to JSON schemas: ${error.message}`);
      throw error;
    }
  }

  async translateOperationToInputSchema(operation: Operation, apiType: ApiType): Promise<JsonSchema | null> {
    try {
      let jsonSchema: JSONSchema7;

      switch (apiType) {
        case ApiType.OPENAPI:
          jsonSchema = translateOpenAPIOperationInput(operation);
          break;
        case ApiType.GRAPHQL:
          jsonSchema = translateGraphQLOperationInput(operation);
          break;
        case ApiType.SOAP:
          jsonSchema = translateSOAPOperationInput(operation);
          break;
        case ApiType.GRPC:
          jsonSchema = translateProtobufOperationInput(operation);
          break;
        default:
          return null;
      }

      const schema = this.jsonSchemaRepository.create({
        name: `${operation.name}_input`,
        description: `Input schema for ${operation.name} operation`,
        type: JsonSchemaType.INPUT,
        schema: jsonSchema as Record<string, any>,
        version: '1.0.0',
        metadata: {
          operationId: operation.id,
          apiType,
          operationName: operation.name,
        },
      });

      return schema;

    } catch (error) {
      this.logger.error(`Failed to translate operation input: ${error.message}`);
      return null;
    }
  }

  async translateOperationToOutputSchema(operation: Operation, apiType: ApiType): Promise<JsonSchema | null> {
    try {
      let jsonSchema: JSONSchema7;

      switch (apiType) {
        case ApiType.OPENAPI:
          jsonSchema = translateOpenAPIOperationOutput(operation);
          break;
        case ApiType.GRAPHQL:
          jsonSchema = translateGraphQLOperationOutput(operation);
          break;
        case ApiType.SOAP:
          jsonSchema = translateSOAPOperationOutput(operation);
          break;
        case ApiType.GRPC:
          jsonSchema = translateProtobufOperationOutput(operation);
          break;
        default:
          return null;
      }

      const schema = this.jsonSchemaRepository.create({
        name: `${operation.name}_output`,
        description: `Output schema for ${operation.name} operation`,
        type: JsonSchemaType.OUTPUT,
        schema: jsonSchema as Record<string, any>,
        version: '1.0.0',
        metadata: {
          operationId: operation.id,
          apiType,
          operationName: operation.name,
        },
      });

      return schema;

    } catch (error) {
      this.logger.error(`Failed to translate operation output: ${error.message}`);
      return null;
    }
  }

  async translateResourceToJsonSchema(resource: Resource, apiType: ApiType): Promise<JsonSchema | null> {
    try {
      // Resources already have JSON schema-like structure
      const jsonSchema: JSONSchema7 = {
        type: 'object',
        title: resource.name,
        description: resource.description,
        properties: {},
        required: [],
      };

      // Convert properties to JSON Schema format
      if (resource.properties) {
        for (const [propName, propDef] of Object.entries(resource.properties)) {
          jsonSchema.properties![propName] = normalizePropertyToJsonSchema(propDef);
          
          if (propDef.required) {
            jsonSchema.required!.push(propName);
          }
        }
      }

      // Use existing schema if available
      if (resource.schema) {
        Object.assign(jsonSchema, resource.schema);
      }

      const schema = this.jsonSchemaRepository.create({
        name: resource.name,
        description: resource.description || `Resource schema: ${resource.name}`,
        type: JsonSchemaType.RESOURCE,
        schema: jsonSchema as Record<string, any>,
        version: '1.0.0',
        metadata: {
          resourceId: resource.id,
          apiType,
          resourceName: resource.name,
          resourceType: resource.type,
        },
      });

      return schema;

    } catch (error) {
      this.logger.error(`Failed to translate resource: ${error.message}`);
      return null;
    }
  }

  async validateJsonSchema(schema: Record<string, any>): Promise<{
    isValid: boolean;
    errors: string[];
  }> {
    try {
      // Basic JSON Schema validation
      if (!schema.type) {
        return {
          isValid: false,
          errors: ['Schema must have a type property'],
        };
      }

      // Additional validations can be added here
      return { isValid: true, errors: [] };

    } catch (error) {
      return {
        isValid: false,
        errors: [error.message],
      };
    }
  }

  async findJsonSchemasByOperation(operationId: string): Promise<JsonSchema[]> {
    return this.jsonSchemaRepository.find({
      where: {
        metadata: { operationId } as any,
      },
    });
  }

  async findJsonSchemasByResource(resourceId: string): Promise<JsonSchema[]> {
    return this.jsonSchemaRepository.find({
      where: {
        metadata: { resourceId } as any,
      },
    });
  }
}