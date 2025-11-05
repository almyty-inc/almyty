import { Test, TestingModule } from '@nestjs/testing';
import { ProtobufParserService } from './protobuf-parser.service';

describe('ProtobufParserService', () => {
  let service: ProtobufParserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProtobufParserService],
    }).compile();

    service = module.get<ProtobufParserService>(ProtobufParserService);
  });

  describe('parseSchema', () => {
    it('should parse Protobuf schema successfully', async () => {
      const protobufSchema = `
        syntax = "proto3";

        package user;

        service UserService {
          rpc GetUser(GetUserRequest) returns (User);
          rpc CreateUser(CreateUserRequest) returns (User);
          rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
        }

        message User {
          string id = 1;
          string name = 2;
          string email = 3;
          int32 age = 4;
        }

        message GetUserRequest {
          string user_id = 1;
        }

        message CreateUserRequest {
          string name = 1;
          string email = 2;
          int32 age = 3;
        }

        message ListUsersRequest {
          int32 limit = 1;
          int32 offset = 2;
        }

        message ListUsersResponse {
          repeated User users = 1;
          int32 total = 2;
        }
      `;

      const result = await service.parseSchema(protobufSchema, 'user.proto');

      expect(result.version).toBeDefined();
      expect(result.info).toBeDefined();
      expect(result.operations).toEqual(expect.any(Array));
      expect(result.resources).toEqual(expect.any(Array));
      expect(result.metadata).toEqual(expect.any(Object));
    });

    it('should handle invalid Protobuf schema', async () => {
      const invalidSchema = 'invalid proto syntax {{{';

      await expect(service.parseSchema(invalidSchema))
        .rejects
        .toThrow();
    });
  });

  describe('validateSchema', () => {
    it('should validate valid Protobuf schema', async () => {
      const validSchema = `
        syntax = "proto3";
        message TestMessage {
          string test_field = 1;
        }
      `;

      const result = await service.validateSchema(validSchema);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return errors for invalid Protobuf schema', async () => {
      const invalidSchema = 'syntax = "invalid" message missing semicolon';

      const result = await service.validateSchema(invalidSchema);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('extractOperations', () => {
    it('should extract operations from parsed schema', async () => {
      const parsedSchema = {
        version: '3',
        info: { title: 'User Service' },
        operations: [
          {
            name: 'GetUser',
            type: 'rpc',
            description: 'Get user by ID',
            input: { name: 'GetUserRequest', type: 'message' },
            output: { name: 'User', type: 'message' }
          },
          {
            name: 'CreateUser',
            type: 'rpc',
            description: 'Create new user',
            input: { name: 'CreateUserRequest', type: 'message' },
            output: { name: 'User', type: 'message' }
          }
        ],
        resources: [],
        metadata: { package: 'user' }
      } as any;

      const result = await service.extractOperations(parsedSchema);

      expect(result).toHaveLength(2);
      const getUserOp = result.find(op => op.name === 'GetUser');
      const createUserOp = result.find(op => op.name === 'CreateUser');
      expect(getUserOp).toBeDefined();
      expect(createUserOp).toBeDefined();
    });

    it('should return empty array for schema with no operations', async () => {
      const parsedSchema = {
        version: '3',
        info: { title: 'Empty Service' },
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
        version: '3',
        info: { title: 'User Service' },
        operations: [],
        resources: [
          {
            name: 'User',
            type: 'message',
            properties: {
              id: { type: 'string', fieldNumber: 1 },
              name: { type: 'string', fieldNumber: 2 },
              email: { type: 'string', fieldNumber: 3 }
            }
          },
          {
            name: 'GetUserRequest',
            type: 'message',
            properties: {
              user_id: { type: 'string', fieldNumber: 1 }
            }
          }
        ],
        metadata: { package: 'user' }
      } as any;

      const result = await service.extractResources(parsedSchema);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('User');
      expect(result[0].type).toBe('message');
      expect(result[1].name).toBe('GetUserRequest');
    });

    it('should return empty array for schema with no resources', async () => {
      const parsedSchema = {
        version: '3',
        info: { title: 'Empty Service' },
        operations: [],
        resources: [],
        metadata: {}
      } as any;

      const result = await service.extractResources(parsedSchema);

      expect(result).toEqual([]);
    });
  });

  describe('parseSchema with advanced features', () => {
    it('should parse schema with nested messages', async () => {
      const protobufSchema = `
        syntax = "proto3";

        message Address {
          string street = 1;
          string city = 2;
          string country = 3;
        }

        message User {
          string id = 1;
          string name = 2;
          Address address = 3;
        }

        service UserService {
          rpc GetUser(string) returns (User);
        }
      `;

      const result = await service.parseSchema(protobufSchema, 'user.proto');

      expect(result.resources).toEqual(expect.any(Array));
      expect(result.operations).toEqual(expect.any(Array));
    });

    it('should parse schema with enums', async () => {
      const protobufSchema = `
        syntax = "proto3";

        enum Status {
          UNKNOWN = 0;
          ACTIVE = 1;
          INACTIVE = 2;
          PENDING = 3;
        }

        message User {
          string id = 1;
          Status status = 2;
        }

        service UserService {
          rpc GetUsersByStatus(Status) returns (User);
        }
      `;

      const result = await service.parseSchema(protobufSchema, 'user.proto');

      expect(result.resources).toEqual(expect.any(Array));
      expect(result.operations).toEqual(expect.any(Array));
    });

    it('should parse schema with repeated fields', async () => {
      const protobufSchema = `
        syntax = "proto3";

        message User {
          string id = 1;
          repeated string tags = 2;
          repeated int32 scores = 3;
        }

        message ListUsersResponse {
          repeated User users = 1;
        }

        service UserService {
          rpc ListUsers(string) returns (ListUsersResponse);
        }
      `;

      const result = await service.parseSchema(protobufSchema, 'user.proto');

      expect(result.resources).toEqual(expect.any(Array));
      expect(result.operations).toEqual(expect.any(Array));
    });

    it('should parse schema with streaming operations', async () => {
      const protobufSchema = `
        syntax = "proto3";

        message StreamRequest {
          string query = 1;
        }

        message StreamResponse {
          string data = 1;
        }

        service StreamService {
          rpc ServerStream(StreamRequest) returns (stream StreamResponse);
          rpc ClientStream(stream StreamRequest) returns (StreamResponse);
          rpc BidirectionalStream(stream StreamRequest) returns (stream StreamResponse);
        }
      `;

      const result = await service.parseSchema(protobufSchema, 'stream.proto');

      expect(result.operations).toEqual(expect.any(Array));
      expect(result.operations.length).toBeGreaterThanOrEqual(3);
    });

    it('should parse schema with map types', async () => {
      const protobufSchema = `
        syntax = "proto3";

        message User {
          string id = 1;
          map<string, string> metadata = 2;
          map<string, int32> scores = 3;
        }

        service UserService {
          rpc GetUser(string) returns (User);
        }
      `;

      const result = await service.parseSchema(protobufSchema, 'user.proto');

      expect(result.resources).toEqual(expect.any(Array));
    });

    it('should parse schema with oneof fields', async () => {
      const protobufSchema = `
        syntax = "proto3";

        message SearchRequest {
          oneof query {
            string text = 1;
            int32 id = 2;
          }
        }

        service SearchService {
          rpc Search(SearchRequest) returns (SearchRequest);
        }
      `;

      const result = await service.parseSchema(protobufSchema, 'search.proto');

      expect(result.resources).toEqual(expect.any(Array));
      expect(result.operations).toEqual(expect.any(Array));
    });
  });
});