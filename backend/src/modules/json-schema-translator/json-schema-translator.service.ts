import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JSONSchema7 } from 'json-schema';

import { JsonSchema, JsonSchemaType } from '../../entities/json-schema.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Api, ApiType } from '../../entities/api.entity';

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
          jsonSchema = this.translateOpenAPIOperationInput(operation);
          break;
        case ApiType.GRAPHQL:
          jsonSchema = this.translateGraphQLOperationInput(operation);
          break;
        case ApiType.SOAP:
          jsonSchema = this.translateSOAPOperationInput(operation);
          break;
        case ApiType.GRPC:
          jsonSchema = this.translateProtobufOperationInput(operation);
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
          jsonSchema = this.translateOpenAPIOperationOutput(operation);
          break;
        case ApiType.GRAPHQL:
          jsonSchema = this.translateGraphQLOperationOutput(operation);
          break;
        case ApiType.SOAP:
          jsonSchema = this.translateSOAPOperationOutput(operation);
          break;
        case ApiType.GRPC:
          jsonSchema = this.translateProtobufOperationOutput(operation);
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
          jsonSchema.properties![propName] = this.normalizePropertyToJsonSchema(propDef);
          
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

  private translateOpenAPIOperationInput(operation: Operation): JSONSchema7 {
    const schema: JSONSchema7 = {
      type: 'object',
      title: `${operation.name} Input`,
      description: `Input parameters for ${operation.name}`,
      properties: {},
      required: [],
    };

    if (operation.parameters) {
      // Path parameters
      if (operation.parameters.path) {
        for (const [name, param] of Object.entries(operation.parameters.path)) {
          schema.properties![name] = this.normalizePropertyToJsonSchema(param);
          if (param.required) {
            schema.required!.push(name);
          }
        }
      }

      // Query parameters
      if (operation.parameters.query) {
        for (const [name, param] of Object.entries(operation.parameters.query)) {
          schema.properties![name] = this.normalizePropertyToJsonSchema(param);
          if (param.required) {
            schema.required!.push(name);
          }
        }
      }

      // Header parameters
      if (operation.parameters.header) {
        for (const [name, param] of Object.entries(operation.parameters.header)) {
          schema.properties![name] = this.normalizePropertyToJsonSchema(param);
          if (param.required) {
            schema.required!.push(name);
          }
        }
      }

      // Body parameters
      if (operation.parameters.body) {
        // If body has schema property, use it
        if (operation.parameters.body.schema) {
          if (typeof operation.parameters.body.schema === 'object') {
            Object.assign(schema, operation.parameters.body.schema);
          }
        }
        // If body has properties directly (flattened structure), use those
        else if (Object.keys(operation.parameters.body).length > 0) {
          for (const [name, param] of Object.entries(operation.parameters.body)) {
            if (name !== 'schema' && typeof param === 'object') {
              schema.properties![name] = this.normalizePropertyToJsonSchema(param);
              if (param.required) {
                schema.required!.push(name);
              }
            }
          }
        }
      }
    }

    return schema;
  }

  private translateOpenAPIOperationOutput(operation: Operation): JSONSchema7 {
    const schema: JSONSchema7 = {
      type: 'object',
      title: `${operation.name} Output`,
      description: `Output response for ${operation.name}`,
      properties: {},
    };

    if (operation.responses) {
      // Use the first successful response (2xx)
      const successResponse = Object.entries(operation.responses)
        .find(([code]) => code.startsWith('2'))?.[1];

      if (successResponse && successResponse.schema) {
        if (typeof successResponse.schema === 'object') {
          Object.assign(schema, successResponse.schema);
        }
      }
    }

    return schema;
  }

  private translateGraphQLOperationInput(operation: Operation): JSONSchema7 {
    const schema: JSONSchema7 = {
      type: 'object',
      title: `${operation.name} Variables`,
      description: `GraphQL variables for ${operation.name}`,
      properties: {},
      required: [],
    };

    if (operation.parameters?.body?.variables?.properties) {
      schema.properties = operation.parameters.body.variables.properties;
      schema.required = operation.parameters.body.variables.required || [];
    }

    return schema;
  }

  private translateGraphQLOperationOutput(operation: Operation): JSONSchema7 {
    return {
      type: 'object',
      title: `${operation.name} Response`,
      description: `GraphQL response for ${operation.name}`,
      properties: {
        data: {
          type: 'object',
          description: 'GraphQL response data',
        },
        errors: {
          type: 'array',
          description: 'GraphQL errors',
          items: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              path: { type: 'array' },
              extensions: { type: 'object' },
            },
          },
        },
      },
    };
  }

  private translateSOAPOperationInput(operation: Operation): JSONSchema7 {
    return {
      type: 'object',
      title: `${operation.name} SOAP Request`,
      description: `SOAP request for ${operation.name}`,
      properties: {
        soapEnvelope: {
          type: 'object',
          properties: {
            'soap:Envelope': {
              type: 'object',
              properties: {
                'soap:Body': {
                  type: 'object',
                  properties: {
                    [operation.name]: {
                      type: 'object',
                      description: `${operation.name} parameters`,
                    },
                  },
                },
              },
            },
          },
        },
      },
      required: ['soapEnvelope'],
    };
  }

  private translateSOAPOperationOutput(operation: Operation): JSONSchema7 {
    return {
      type: 'object',
      title: `${operation.name} SOAP Response`,
      description: `SOAP response for ${operation.name}`,
      properties: {
        soapEnvelope: {
          type: 'object',
          properties: {
            'soap:Envelope': {
              type: 'object',
              properties: {
                'soap:Body': {
                  type: 'object',
                  properties: {
                    [`${operation.name}Response`]: {
                      type: 'object',
                      description: `${operation.name} response`,
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  private translateProtobufOperationInput(operation: Operation): JSONSchema7 {
    const schema: JSONSchema7 = {
      type: 'object',
      title: `${operation.name} gRPC Request`,
      description: `gRPC request for ${operation.name}`,
      properties: {},
    };

    if (operation.parameters?.body?.message?.properties) {
      schema.properties = operation.parameters.body.message.properties;
    }

    return schema;
  }

  private translateProtobufOperationOutput(operation: Operation): JSONSchema7 {
    const schema: JSONSchema7 = {
      type: 'object',
      title: `${operation.name} gRPC Response`,
      description: `gRPC response for ${operation.name}`,
      properties: {},
    };

    if (operation.responses?.['200']?.schema?.properties) {
      schema.properties = operation.responses['200'].schema.properties;
    }

    return schema;
  }

  private normalizePropertyToJsonSchema(property: any): JSONSchema7 {
    if (typeof property === 'object' && property.type) {
      return property as JSONSchema7;
    }

    // Handle different property formats
    const normalized: JSONSchema7 = {
      type: 'string', // Default type
    };

    if (property.type) {
      normalized.type = property.type;
    }

    if (property.description) {
      normalized.description = property.description;
    }

    if (property.example !== undefined) {
      normalized.examples = [property.example];
    }

    if (property.enum) {
      normalized.enum = property.enum;
    }

    if (property.format) {
      normalized.format = property.format;
    }

    if (property.minimum !== undefined) {
      normalized.minimum = property.minimum;
    }

    if (property.maximum !== undefined) {
      normalized.maximum = property.maximum;
    }

    if (property.minLength !== undefined) {
      normalized.minLength = property.minLength;
    }

    if (property.maxLength !== undefined) {
      normalized.maxLength = property.maxLength;
    }

    if (property.pattern) {
      normalized.pattern = property.pattern;
    }

    if (property.items) {
      normalized.items = this.normalizePropertyToJsonSchema(property.items);
    }

    if (property.properties) {
      normalized.properties = {};
      for (const [name, prop] of Object.entries(property.properties)) {
        normalized.properties[name] = this.normalizePropertyToJsonSchema(prop);
      }
    }

    if (property.required && Array.isArray(property.required)) {
      normalized.required = property.required;
    }

    return normalized;
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