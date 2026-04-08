import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Api, ApiType } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';

import { OpenAPIParserService } from './parsers/openapi-parser.service';
import { GraphQLParserService } from './parsers/graphql-parser.service';
import { SOAPParserService } from './parsers/soap-parser.service';
import { ProtobufParserService } from './parsers/protobuf-parser.service';

import { SchemaParser, ParsedSchema } from './interfaces/parser.interface';

@Injectable()
export class SchemaParserService {
  private readonly logger = new Logger(SchemaParserService.name);
  
  constructor(
    @InjectRepository(ApiSchema)
    private apiSchemaRepository: Repository<ApiSchema>,
    @InjectRepository(Operation)
    private operationRepository: Repository<Operation>,
    @InjectRepository(Resource)
    private resourceRepository: Repository<Resource>,
    private openAPIParser: OpenAPIParserService,
    private graphQLParser: GraphQLParserService,
    private soapParser: SOAPParserService,
    private protobufParser: ProtobufParserService,
  ) {}

  async parseAndStore(
    api: Api,
    rawSchema: string,
    fileName?: string,
  ): Promise<{
    apiSchema: ApiSchema;
    operations: Operation[];
    resources: Resource[];
  }> {
    const parser = this.getParserForApiType(api.type);
    
    try {
      // Parse the schema
      const parsedSchema = await parser.parseSchema(rawSchema, fileName);
      
      // Validate the parsed schema
      const validation = await parser.validateSchema(rawSchema);
      if (!validation.isValid) {
        throw new BadRequestException(`Schema validation failed: ${validation.errors.join(', ')}`);
      }

      // Create and save ApiSchema
      const apiSchema = this.apiSchemaRepository.create({
        apiId: api.id,
        rawSchema,
        processedSchema: parsedSchema,
        version: parsedSchema.info.version,
        fileName,
        fileSize: Buffer.byteLength(rawSchema, 'utf8'),
        validationResults: {
          isValid: validation.isValid,
          errors: validation.errors.map(error => ({
            path: '',
            message: error,
            severity: 'error' as const,
          })),
          warnings: [],
        },
        statistics: {
          operationCount: parsedSchema.operations.length,
          resourceCount: parsedSchema.resources.length,
          endpointCount: parsedSchema.operations.length,
          methodCounts: this.countMethods(parsedSchema.operations),
        },
        metadata: parsedSchema.metadata,
      });

      const savedApiSchema = await this.apiSchemaRepository.save(apiSchema);

      // Extract and save operations
      const operations = await parser.extractOperations(parsedSchema);
      for (const operation of operations) {
        operation.apiId = api.id;
      }
      const savedOperations = await this.operationRepository.save(operations);

      // Extract and save resources
      const resources = await parser.extractResources(parsedSchema);
      for (const resource of resources) {
        resource.apiId = api.id;
      }
      const savedResources = await this.resourceRepository.save(resources);

      this.logger.log(
        `Successfully parsed ${api.type} schema: ${savedOperations.length} operations, ${savedResources.length} resources`
      );

      return {
        apiSchema: savedApiSchema,
        operations: savedOperations,
        resources: savedResources,
      };

    } catch (error) {
      this.logger.error(`Failed to parse ${api.type} schema: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to parse schema: ${error.message}`);
    }
  }

  async reparse(apiSchema: ApiSchema): Promise<{
    operations: Operation[];
    resources: Resource[];
  }> {
    const api = apiSchema.api;
    const parser = this.getParserForApiType(api.type);

    // Parse BEFORE touching the database. If parsing fails, we want
    // the caller to get a BadRequest and walk away — not a half-wiped
    // API with zero operations/resources because we deleted
    // everything *before* attempting the parse and then the parse
    // threw. Do the work that can fail cheaply first.
    let parsedSchema: ParsedSchema;
    let operations: Operation[];
    let resources: Resource[];
    try {
      parsedSchema = await parser.parseSchema(apiSchema.rawSchema);
      operations = await parser.extractOperations(parsedSchema);
      resources = await parser.extractResources(parsedSchema);
    } catch (error) {
      this.logger.error(`Failed to reparse schema: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to reparse schema: ${error.message}`);
    }

    for (const operation of operations) {
      operation.apiId = api.id;
    }
    for (const resource of resources) {
      resource.apiId = api.id;
    }

    // Delete-then-insert needs to be one atomic unit. Previously the
    // delete ran outside any transaction boundary, so a partial insert
    // failure (unique constraint violation on an extracted operation,
    // DB disconnect, OOM) would leave the API with its old operations
    // and resources gone and the new ones partially applied. Wrap the
    // three writes in a single transaction so the API row either sees
    // the new state completely or the old state untouched.
    try {
      const [savedOperations, savedResources] = await this.apiSchemaRepository.manager.transaction(
        async (tx) => {
          await tx.delete(Operation, { apiId: api.id });
          await tx.delete(Resource, { apiId: api.id });

          const savedOps = await tx.save(Operation, operations);
          const savedRes = await tx.save(Resource, resources);

          // Update schema statistics inside the same transaction.
          apiSchema.statistics = {
            operationCount: savedOps.length,
            resourceCount: savedRes.length,
            endpointCount: savedOps.length,
            methodCounts: this.countMethods(parsedSchema.operations),
          };
          await tx.save(ApiSchema, apiSchema);

          return [savedOps, savedRes] as const;
        },
      );

      return {
        operations: savedOperations,
        resources: savedResources,
      };
    } catch (error) {
      this.logger.error(`Failed to persist reparsed schema: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to persist reparsed schema: ${error.message}`);
    }
  }

  async validateSchemaString(apiType: ApiType, schema: string): Promise<{
    isValid: boolean;
    errors: string[];
    warnings: string[];
    preview?: {
      operationCount: number;
      resourceCount: number;
      title: string;
      version: string;
    };
  }> {
    const parser = this.getParserForApiType(apiType);

    try {
      const validation = await parser.validateSchema(schema);
      
      if (validation.isValid) {
        // If valid, provide a preview
        const parsedSchema = await parser.parseSchema(schema);
        return {
          ...validation,
          warnings: [],
          preview: {
            operationCount: parsedSchema.operations.length,
            resourceCount: parsedSchema.resources.length,
            title: parsedSchema.info.title,
            version: parsedSchema.info.version,
          },
        };
      }

      return {
        ...validation,
        warnings: [],
      };

    } catch (error) {
      return {
        isValid: false,
        errors: [error.message],
        warnings: [],
      };
    }
  }

  getParserForApiType(apiType: ApiType): SchemaParser {
    switch (apiType) {
      case ApiType.OPENAPI:
        return this.openAPIParser;
      case ApiType.GRAPHQL:
        return this.graphQLParser;
      case ApiType.SOAP:
        return this.soapParser;
      case ApiType.GRPC:
        return this.protobufParser;
      default:
        throw new BadRequestException(`Unsupported API type: ${apiType}`);
    }
  }

  private countMethods(operations: any[]): Record<string, number> {
    const counts: Record<string, number> = {};
    
    for (const operation of operations) {
      const method = operation.method?.toUpperCase() || 'UNKNOWN';
      counts[method] = (counts[method] || 0) + 1;
    }
    
    return counts;
  }

  async getSchemaPreview(apiType: ApiType, schema: string): Promise<{
    title: string;
    description?: string;
    version: string;
    operationSummary: Array<{
      name: string;
      method: string;
      endpoint: string;
      description?: string;
    }>;
    resourceSummary: Array<{
      name: string;
      type: string;
      properties: number;
    }>;
  }> {
    const parser = this.getParserForApiType(apiType);
    const parsedSchema = await parser.parseSchema(schema);

    return {
      title: parsedSchema.info.title,
      description: parsedSchema.info.description,
      version: parsedSchema.info.version,
      operationSummary: parsedSchema.operations.slice(0, 10).map(op => ({
        name: op.name,
        method: op.method,
        endpoint: op.endpoint,
        description: op.description,
      })),
      resourceSummary: parsedSchema.resources.slice(0, 10).map(resource => ({
        name: resource.name,
        type: resource.type,
        properties: Object.keys(resource.properties || {}).length,
      })),
    };
  }

  async parseApiSchema(
    rawSchema: string,
    apiType: ApiType,
    fileName?: string,
  ): Promise<ParsedSchema> {
    const parser = this.getParserForApiType(apiType);
    return parser.parseSchema(rawSchema, fileName);
  }

  async extractOperationsFromParsedSchema(parsedSchema: ParsedSchema): Promise<Operation[]> {
    // Find the appropriate parser based on schema metadata
    const apiType = this.detectApiTypeFromSchema(parsedSchema);
    const parser = this.getParserForApiType(apiType);
    return parser.extractOperations(parsedSchema);
  }

  async extractResourcesFromParsedSchema(parsedSchema: ParsedSchema): Promise<Resource[]> {
    // Find the appropriate parser based on schema metadata
    const apiType = this.detectApiTypeFromSchema(parsedSchema);
    const parser = this.getParserForApiType(apiType);
    return parser.extractResources(parsedSchema);
  }

  private detectApiTypeFromSchema(parsedSchema: ParsedSchema): ApiType {
    if (parsedSchema.metadata?.schemaType) {
      switch (parsedSchema.metadata.schemaType) {
        case 'openapi':
          return ApiType.OPENAPI;
        case 'graphql':
          return ApiType.GRAPHQL;
        case 'soap':
          return ApiType.SOAP;
        case 'protobuf':
        case 'grpc':
          return ApiType.GRPC;
        default:
          return ApiType.OTHER;
      }
    }
    
    // Fallback to OTHER if we can't detect
    return ApiType.OTHER;
  }
}