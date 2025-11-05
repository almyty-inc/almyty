import { Test, TestingModule } from '@nestjs/testing';
import { GraphQLParserService } from './graphql-parser.service';

describe('GraphQLParserService', () => {
  let service: GraphQLParserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GraphQLParserService],
    }).compile();

    service = module.get<GraphQLParserService>(GraphQLParserService);
  });

  describe('parseSchema', () => {
    it('should parse GraphQL schema successfully', async () => {
      const graphqlSchema = `
        type User {
          id: ID!
          name: String!
          email: String
          age: Int
        }

        type Query {
          getUser(id: ID!): User
          getUsers(limit: Int): [User]
        }

        type Mutation {
          createUser(input: CreateUserInput!): User
          updateUser(id: ID!, input: UpdateUserInput!): User
          deleteUser(id: ID!): Boolean
        }

        input CreateUserInput {
          name: String!
          email: String
          age: Int
        }

        input UpdateUserInput {
          name: String
          email: String
          age: Int
        }
      `;

      const result = await service.parseSchema(graphqlSchema, 'schema.graphql');

      expect(result.version).toBeDefined();
      expect(result.info).toBeDefined();
      expect(result.operations).toEqual(expect.any(Array));
      expect(result.resources).toEqual(expect.any(Array));
      expect(result.metadata).toEqual(expect.any(Object));
    });

    it('should parse schema with subscriptions', async () => {
      const graphqlSchema = `
        type User {
          id: ID!
          name: String!
        }

        type Query {
          getUser(id: ID!): User
        }

        type Subscription {
          userUpdated(id: ID!): User
          userCreated: User
        }
      `;

      const result = await service.parseSchema(graphqlSchema, 'schema.graphql');

      expect(result.operations).toEqual(expect.any(Array));
      expect(result.operations.length).toBeGreaterThan(0);
      const subscription = result.operations.find(op => op.method === 'subscription');
      expect(subscription).toBeDefined();
    });

    it('should parse schema with enums and arrays', async () => {
      const graphqlSchema = `
        enum UserStatus {
          ACTIVE
          INACTIVE
          PENDING
        }

        type User {
          id: ID!
          name: String!
          status: UserStatus
          tags: [String]
          friends: [User]
        }

        type Query {
          getUsers(status: UserStatus): [User]
        }
      `;

      const result = await service.parseSchema(graphqlSchema, 'schema.graphql');

      expect(result.resources).toEqual(expect.any(Array));
      expect(result.operations).toEqual(expect.any(Array));
    });

    it('should parse schema with custom scalar types', async () => {
      const graphqlSchema = `
        scalar DateTime
        scalar JSON

        type Event {
          id: ID!
          timestamp: DateTime
          metadata: JSON
        }

        type Query {
          getEvent(id: ID!): Event
        }
      `;

      const result = await service.parseSchema(graphqlSchema, 'schema.graphql');

      expect(result.resources).toEqual(expect.any(Array));
      expect(result.operations).toEqual(expect.any(Array));
    });

    it('should handle invalid GraphQL schema', async () => {
      const invalidSchema = 'invalid graphql syntax {{{';

      await expect(service.parseSchema(invalidSchema))
        .rejects
        .toThrow();
    });
  });

  describe('validateSchema', () => {
    it('should validate valid GraphQL schema', async () => {
      const validSchema = `
        type Query {
          hello: String
        }
      `;

      const result = await service.validateSchema(validSchema);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return errors for invalid GraphQL schema', async () => {
      const invalidSchema = 'type Query { invalid syntax }';

      const result = await service.validateSchema(invalidSchema);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('extractOperations', () => {
    it('should extract operations from parsed schema', async () => {
      const parsedSchema = {
        version: '1.0',
        info: { title: 'User API' },
        operations: [
          {
            name: 'getUser',
            type: 'query',
            description: 'Get user by ID',
            parameters: { id: { type: 'ID', required: true } },
            returnType: 'User'
          },
          {
            name: 'createUser',
            type: 'mutation',
            description: 'Create new user',
            parameters: { input: { type: 'CreateUserInput', required: true } },
            returnType: 'User'
          }
        ],
        resources: [],
        metadata: {}
      } as any;

      const result = await service.extractOperations(parsedSchema);

      expect(result).toHaveLength(2);
      // Operations might be returned in different order
      const getUserOp = result.find(op => op.name === 'getUser');
      const createUserOp = result.find(op => op.name === 'createUser');
      expect(getUserOp).toBeDefined();
      expect(createUserOp).toBeDefined();
    });

    it('should return empty array for schema with no operations', async () => {
      const parsedSchema = {
        version: '1.0',
        info: { title: 'Empty API' },
        operations: [],
        resources: [],
        metadata: {}
      } as any;

      const result = await service.extractOperations(parsedSchema);

      expect(result).toEqual([]);
    });
  });

  describe('extractResources', () => {
    it('should extract resources from parsed schema', async () => {
      const parsedSchema = {
        version: '1.0',
        info: { title: 'User API' },
        operations: [],
        resources: [
          {
            name: 'User',
            type: 'object',
            properties: {
              id: { type: 'ID' },
              name: { type: 'String' },
              email: { type: 'String' }
            }
          },
          {
            name: 'CreateUserInput',
            type: 'input',
            properties: {
              name: { type: 'String' },
              email: { type: 'String' }
            }
          }
        ],
        metadata: {}
      } as any;

      const result = await service.extractResources(parsedSchema);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('User');
      expect(result[0].type).toBe('object');
      expect(result[1].name).toBe('CreateUserInput');
      expect(result[1].type).toBe('input');
    });

    it('should return empty array for schema with no resources', async () => {
      const parsedSchema = {
        version: '1.0',
        info: { title: 'Empty API' },
        operations: [],
        resources: [],
        metadata: {}
      } as any;

      const result = await service.extractResources(parsedSchema);

      expect(result).toEqual([]);
    });
  });
});