import { Injectable, Logger } from '@nestjs/common';
import * as protobuf from 'protobufjs';

import { Operation, OperationType, HttpMethod } from '../../../entities/operation.entity';
import { Resource, ResourceType } from '../../../entities/resource.entity';
import { SchemaParser, ParsedSchema, ParsedOperation, ParsedResource } from '../interfaces/parser.interface';

/** Hard cap on .proto input size — memory DoS protection. */
const MAX_PROTO_BYTES = 5 * 1024 * 1024; // 5 MB

@Injectable()
export class ProtobufParserService implements SchemaParser {
  private readonly logger = new Logger(ProtobufParserService.name);

  async parseSchema(rawSchema: string, fileName?: string): Promise<ParsedSchema> {
    try {
      if (typeof rawSchema === 'string' && rawSchema.length > MAX_PROTO_BYTES) {
        throw new Error(`Protobuf schema exceeds max size of ${MAX_PROTO_BYTES} bytes`);
      }
      const root = protobuf.parse(rawSchema).root;
      
      const operations = await this.extractOperationsFromProtobuf(root);
      const resources = await this.extractResourcesFromProtobuf(root);

      return {
        version: '1.0.0',
        info: {
          title: 'Protobuf Service',
          description: 'Generated from Protocol Buffer definition',
          version: '1.0.0',
        },
        operations,
        resources,
        metadata: {
          fileName,
          schemaType: 'protobuf',
          // `originalProto: rawSchema` was retained here for no
          // downstream consumer — the raw proto text is already
          // persisted as ApiSchema.rawSchema in DB. On a massive
          // proto (Google APIs hit ~10 MB) this doubled the
          // parser's peak heap.
          packageName: root.name,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to parse Protobuf schema: ${error.message}`);
      throw new Error(`Invalid Protobuf schema: ${error.message}`);
    }
  }

  async validateSchema(schema: string): Promise<{ isValid: boolean; errors: string[] }> {
    try {
      if (typeof schema === 'string' && schema.length > MAX_PROTO_BYTES) {
        return {
          isValid: false,
          errors: [`Protobuf schema exceeds max size of ${MAX_PROTO_BYTES} bytes`],
        };
      }
      protobuf.parse(schema);
      return { isValid: true, errors: [] };
    } catch (error) {
      return {
        isValid: false,
        errors: [error.message],
      };
    }
  }

  async extractOperations(schema: ParsedSchema): Promise<Operation[]> {
    const operations: Operation[] = [];

    for (const parsedOp of schema.operations) {
      const operation = new Operation();
      operation.name = parsedOp.name;
      operation.operationId = parsedOp.operationId;
      operation.description = parsedOp.description;
      operation.method = HttpMethod.POST; // gRPC typically uses POST
      operation.endpoint = `/grpc/${parsedOp.name}`;
      operation.type = OperationType.RPC;
      operation.parameters = parsedOp.parameters;
      operation.responses = parsedOp.responses;
      operation.tags = parsedOp.tags;
      operation.isActive = true;

      operations.push(operation);
    }

    return operations;
  }

  async extractResources(schema: ParsedSchema): Promise<Resource[]> {
    const resources: Resource[] = [];

    for (const parsedResource of schema.resources) {
      const resource = new Resource();
      resource.name = parsedResource.name;
      resource.description = parsedResource.description;
      resource.type = parsedResource.type as ResourceType;
      resource.properties = parsedResource.properties;
      resource.schema = parsedResource.schema;
      resource.isActive = true;

      resources.push(resource);
    }

    return resources;
  }

  private async extractOperationsFromProtobuf(root: protobuf.Root): Promise<ParsedOperation[]> {
    const operations: ParsedOperation[] = [];

    // Recursively traverse to find all services (including inside package namespaces)
    this.traverseServices(root, (service) => {
      service.methodsArray.forEach(method => {
        const operationName = `${service.name}_${method.name}`;

        operations.push({
          operationId: operationName,
          name: method.name,
          description: method.comment || `${service.name} service method: ${method.name}`,
          method: 'grpc',
          endpoint: `/grpc/${service.name}/${method.name}`,
          parameters: {
            body: {
              message: {
                type: 'object',
                description: `Request message of type: ${method.requestType}`,
                properties: this.getMessageProperties(root, method.requestType),
              },
            },
            header: {
              'Content-Type': {
                type: 'string',
                default: 'application/grpc',
              },
              'grpc-encoding': {
                type: 'string',
                description: 'gRPC encoding',
                enum: ['identity', 'gzip'],
              },
            },
          },
          responses: {
            '200': {
              description: 'gRPC response',
              schema: {
                type: 'object',
                description: `Response message of type: ${method.responseType}`,
                properties: this.getMessageProperties(root, method.responseType),
              },
            },
            'default': {
              description: 'gRPC error',
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'integer', description: 'gRPC status code' },
                  message: { type: 'string', description: 'Error message' },
                  details: { type: 'array', description: 'Error details' },
                },
              },
            },
          },
          tags: ['grpc', service.name],
        });
      });
    });

    return operations;
  }

  private traverseServices(object: protobuf.ReflectionObject, callback: (service: protobuf.Service) => void): void {
    if (object instanceof protobuf.Service) {
      callback(object);
    }

    if ((object as any).nestedArray) {
      (object as any).nestedArray.forEach(nested => this.traverseServices(nested, callback));
    }
  }

  private async extractResourcesFromProtobuf(root: protobuf.Root): Promise<ParsedResource[]> {
    const resources: ParsedResource[] = [];

    // Extract messages (types)
    this.traverseMessages(root, (message) => {
      const properties = this.extractMessageProperties(message);
      
      resources.push({
        name: message.name,
        description: message.comment || `Protocol Buffer message: ${message.name}`,
        type: ResourceType.MODEL,
        properties,
        schema: {
          type: 'object',
          properties,
          description: message.comment || `Protocol Buffer message: ${message.name}`,
          required: this.getRequiredFields(message),
        },
      });
    });

    // Extract enums
    this.traverseEnums(root, (enumType) => {
      const enumValues = Object.keys(enumType.values);
      
      resources.push({
        name: enumType.name,
        description: enumType.comment || `Protocol Buffer enum: ${enumType.name}`,
        type: ResourceType.ENUM,
        properties: {},
        schema: {
          type: 'string',
          enum: enumValues,
          description: enumType.comment || `Protocol Buffer enum: ${enumType.name}`,
        },
      });
    });

    return resources;
  }

  private traverseMessages(object: protobuf.ReflectionObject, callback: (message: protobuf.Type) => void): void {
    if (object instanceof protobuf.Type) {
      callback(object);
    }
    
    if ((object as any).nestedArray) {
      (object as any).nestedArray.forEach(nested => this.traverseMessages(nested, callback));
    }
  }

  private traverseEnums(object: protobuf.ReflectionObject, callback: (enumType: protobuf.Enum) => void): void {
    if (object instanceof protobuf.Enum) {
      callback(object);
    }
    
    if ((object as any).nestedArray) {
      (object as any).nestedArray.forEach(nested => this.traverseEnums(nested, callback));
    }
  }

  private extractMessageProperties(message: protobuf.Type): Record<string, any> {
    const properties: Record<string, any> = {};

    message.fieldsArray.forEach(field => {
      properties[field.name] = {
        type: this.mapProtobufTypeToJsonType(field.type),
        description: field.comment || `Field: ${field.name}`,
        required: field.required,
        repeated: field.repeated,
        protobufType: field.type,
        protobufId: field.id,
      };

      // Handle repeated fields
      if (field.repeated) {
        properties[field.name] = {
          type: 'array',
          items: {
            type: this.mapProtobufTypeToJsonType(field.type),
          },
          description: field.comment || `Repeated field: ${field.name}`,
        };
      }
    });

    return properties;
  }

  private getMessageProperties(root: protobuf.Root, messageTypeName: string): Record<string, any> {
    try {
      const messageType = root.lookupType(messageTypeName);
      return this.extractMessageProperties(messageType);
    } catch (error) {
      this.logger.warn(`Could not find message type: ${messageTypeName}`);
      return {};
    }
  }

  private getRequiredFields(message: protobuf.Type): string[] {
    return message.fieldsArray
      .filter(field => field.required)
      .map(field => field.name);
  }

  private mapProtobufTypeToJsonType(protobufType: string): string {
    switch (protobufType) {
      case 'string':
        return 'string';
      case 'int32':
      case 'int64':
      case 'uint32':
      case 'uint64':
      case 'sint32':
      case 'sint64':
      case 'fixed32':
      case 'fixed64':
      case 'sfixed32':
      case 'sfixed64':
        return 'integer';
      case 'float':
      case 'double':
        return 'number';
      case 'bool':
        return 'boolean';
      case 'bytes':
        return 'string'; // Base64 encoded
      default:
        // Custom message type or enum
        return 'object';
    }
  }
}