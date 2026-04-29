import { Injectable, Logger } from '@nestjs/common';
import {
  buildSchema,
  GraphQLSchema,
  isObjectType,
  isScalarType,
  isEnumType,
  isListType,
  isNonNullType,
  GraphQLObjectType,
  GraphQLField,
  GraphQLArgument,
} from 'graphql';

import { Operation, OperationType, HttpMethod } from '../../../entities/operation.entity';
import { Resource, ResourceType } from '../../../entities/resource.entity';
import { SchemaParser, ParsedSchema, ParsedOperation, ParsedResource } from '../interfaces/parser.interface';

/** Hard cap on GraphQL SDL input size — memory DoS protection. */
const MAX_SDL_BYTES = 5 * 1024 * 1024; // 5 MB

@Injectable()
export class GraphQLParserService implements SchemaParser {
  private readonly logger = new Logger(GraphQLParserService.name);

  async parseSchema(rawSchema: string, fileName?: string): Promise<ParsedSchema> {
    try {
      if (typeof rawSchema === 'string' && rawSchema.length > MAX_SDL_BYTES) {
        throw new Error(`GraphQL schema exceeds max size of ${MAX_SDL_BYTES} bytes`);
      }
      const schema = buildSchema(rawSchema);

      const operations = await this.extractOperationsFromGraphQL(schema);
      const resources = await this.extractResourcesFromGraphQL(schema);

      return {
        version: '1.0.0', // GraphQL doesn't have versioning in schema
        info: {
          title: 'GraphQL API',
          description: 'Generated from GraphQL schema',
          version: '1.0.0',
        },
        operations,
        resources,
        metadata: {
          fileName,
          schemaType: 'graphql',
          // `originalSchema: rawSchema` was retained here for no
          // downstream consumer — the raw SDL is already persisted
          // as ApiSchema.rawSchema in DB. On a 50 MB SDL this
          // doubled the parser's peak heap for nothing.
        },
      };
    } catch (error) {
      this.logger.error(`Failed to parse GraphQL schema: ${error.message}`);
      throw new Error(`Invalid GraphQL schema: ${error.message}`);
    }
  }

  async validateSchema(schema: string): Promise<{ isValid: boolean; errors: string[] }> {
    try {
      if (typeof schema === 'string' && schema.length > MAX_SDL_BYTES) {
        return {
          isValid: false,
          errors: [`GraphQL schema exceeds max size of ${MAX_SDL_BYTES} bytes`],
        };
      }
      buildSchema(schema);
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
      operation.method = HttpMethod.POST; // GraphQL typically uses POST
      operation.endpoint = '/graphql';
      operation.type = parsedOp.method === 'query' ? OperationType.QUERY : OperationType.MUTATION;
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

  private async extractOperationsFromGraphQL(schema: GraphQLSchema): Promise<ParsedOperation[]> {
    const operations: ParsedOperation[] = [];

    // Extract queries
    const queryType = schema.getQueryType();
    if (queryType) {
      const queryFields = queryType.getFields();
      for (const [fieldName, field] of Object.entries(queryFields)) {
        operations.push(this.createOperationFromField(fieldName, field, 'query'));
      }
    }

    // Extract mutations
    const mutationType = schema.getMutationType();
    if (mutationType) {
      const mutationFields = mutationType.getFields();
      for (const [fieldName, field] of Object.entries(mutationFields)) {
        operations.push(this.createOperationFromField(fieldName, field, 'mutation'));
      }
    }

    // Extract subscriptions
    const subscriptionType = schema.getSubscriptionType();
    if (subscriptionType) {
      const subscriptionFields = subscriptionType.getFields();
      for (const [fieldName, field] of Object.entries(subscriptionFields)) {
        operations.push(this.createOperationFromField(fieldName, field, 'subscription'));
      }
    }

    return operations;
  }

  private createOperationFromField(fieldName: string, field: GraphQLField<any, any>, operationType: string): ParsedOperation {
    return {
      operationId: `${operationType}_${fieldName}`,
      name: fieldName,
      description: field.description,
      method: operationType,
      endpoint: `/graphql`,
      parameters: {
        body: {
          query: {
            type: 'string',
            description: 'GraphQL query string',
            required: true,
          },
          variables: {
            type: 'object',
            description: 'GraphQL variables',
            properties: this.extractArgumentsAsProperties(field.args),
          },
        },
      },
      responses: {
        '200': {
          description: 'GraphQL response',
          schema: {
            type: 'object',
            properties: {
              data: this.convertGraphQLTypeToJsonSchema(field.type),
              errors: {
                type: 'array',
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
          },
        },
      },
      tags: [operationType],
    };
  }

  private extractArgumentsAsProperties(args: readonly GraphQLArgument[]): Record<string, any> {
    const properties: Record<string, any> = {};

    for (const arg of args) {
      properties[arg.name] = {
        ...this.convertGraphQLTypeToJsonSchema(arg.type),
        // Preserve the original GraphQL type signature ("ID!",
        // "[String!]!", "Int") so downstream consumers (the skill
        // generator's query template builder, and any UI showing
        // variables) can render it back faithfully. Without this,
        // ID! → JSON 'string' → re-rendered as 'String' and the
        // server rejects the call with a type-mismatch error.
        gqlType: this.formatGraphQLType(arg.type),
        description: arg.description,
      };
    }

    return properties;
  }

  /** Render a GraphQL type back into its source-style signature. */
  private formatGraphQLType(graphqlType: any): string {
    if (isNonNullType(graphqlType)) {
      return `${this.formatGraphQLType(graphqlType.ofType)}!`;
    }
    if (isListType(graphqlType)) {
      return `[${this.formatGraphQLType(graphqlType.ofType)}]`;
    }
    return graphqlType.name || 'String';
  }

  private async extractResourcesFromGraphQL(schema: GraphQLSchema): Promise<ParsedResource[]> {
    const resources: ParsedResource[] = [];
    const typeMap = schema.getTypeMap();

    for (const [typeName, type] of Object.entries(typeMap)) {
      // Skip built-in GraphQL types
      if (typeName.startsWith('__')) continue;

      if (isObjectType(type) && !['Query', 'Mutation', 'Subscription'].includes(typeName)) {
        const fields = type.getFields();
        const properties: Record<string, any> = {};

        for (const [fieldName, field] of Object.entries(fields)) {
          properties[fieldName] = {
            ...this.convertGraphQLTypeToJsonSchema(field.type),
            description: field.description,
            required: false, // GraphQL handles this differently
          };
        }

        resources.push({
          name: typeName,
          description: type.description,
          type: ResourceType.MODEL,
          properties,
          schema: {
            type: 'object',
            properties,
            description: type.description,
          },
        });
      } else if (isEnumType(type)) {
        const enumValues = type.getValues().map(value => value.value);
        
        resources.push({
          name: typeName,
          description: type.description,
          type: ResourceType.ENUM,
          properties: {},
          schema: {
            type: 'string',
            enum: enumValues,
            description: type.description,
          },
        });
      }
    }

    return resources;
  }

  private convertGraphQLTypeToJsonSchema(
    graphqlType: any,
    depth = 0,
  ): Record<string, any> {
    // Handle NonNull types: unwrap and recurse on the inner type.
    // Use isNonNullType explicitly — the previous shape branched on
    // the presence of `.ofType`, which ALSO exists on List types,
    // so `[String]` got caught by this branch and recursed straight
    // to its element type. That silently turned every list field
    // into its scalar/object element, losing the array-ness entirely,
    // and the resulting JSON schema (used as tool argument metadata
    // handed to LLMs) told models to send a single object where the
    // GraphQL API actually expected an array. Handle NonNull and
    // List as distinct shapes, in the right order.
    if (isNonNullType(graphqlType)) {
      return this.convertGraphQLTypeToJsonSchema(graphqlType.ofType, depth);
    }

    // Handle List types
    if (isListType(graphqlType)) {
      return {
        type: 'array',
        items: this.convertGraphQLTypeToJsonSchema(graphqlType.ofType, depth),
      };
    }

    // Handle scalar types
    if (isScalarType(graphqlType)) {
      switch (graphqlType.name) {
        case 'String':
          return { type: 'string' };
        case 'Int':
        case 'Float':
          return { type: 'number' };
        case 'Boolean':
          return { type: 'boolean' };
        case 'ID':
          return { type: 'string' };
        default:
          return { type: 'string' };
      }
    }

    // Handle enum types
    if (isEnumType(graphqlType)) {
      return {
        type: 'string',
        enum: graphqlType.getValues().map(value => value.value),
      };
    }

    // Handle object types — walk one level deep so the SKILL.md
    // generator has the field list it needs to emit a useful
    // selection set instead of a `__typename` stub. Cap recursion at
    // depth 1 so a self-referential type (e.g. Country.continent →
    // Continent.countries → Country) doesn't blow the stack or the
    // serialized schema.
    if (isObjectType(graphqlType)) {
      const out: Record<string, any> = {
        type: 'object',
        description: graphqlType.description,
      };
      if (depth < 1) {
        const fields = (graphqlType as GraphQLObjectType).getFields();
        const properties: Record<string, any> = {};
        for (const [name, field] of Object.entries(fields)) {
          properties[name] = this.convertGraphQLTypeToJsonSchema(
            field.type,
            depth + 1,
          );
        }
        out.properties = properties;
      }
      return out;
    }

    // Default fallback
    return {
      type: 'object',
      description: 'GraphQL type',
    };
  }
}