import { Test, TestingModule } from '@nestjs/testing';

import { SchemaParserService } from './schema-parser.service';
import { ApiType } from '../../entities/api.entity';

import { OpenAPIParserService } from './parsers/openapi-parser.service';
import { GraphQLParserService } from './parsers/graphql-parser.service';
import { SOAPParserService } from './parsers/soap-parser.service';
import { ProtobufParserService } from './parsers/protobuf-parser.service';

/**
 * The service picks a parser and runs it. The six methods this file used
 * to spend 730 lines on — `parseAndStore`, `reparse`,
 * `validateSchemaString`, `getSchemaPreview` and the two
 * `extract*FromParsedSchema` — had no production caller, so their specs
 * were the only thing keeping them alive. The transactional-manager
 * scaffolding in the old setup existed solely for `reparse` and went
 * with it.
 */
describe('SchemaParserService', () => {
  let service: SchemaParserService;
  let openAPIParser: OpenAPIParserService;
  let graphQLParser: GraphQLParserService;
  let soapParser: SOAPParserService;
  let protobufParser: ProtobufParserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemaParserService,
        OpenAPIParserService,
        GraphQLParserService,
        SOAPParserService,
        ProtobufParserService,
      ],
    }).compile();

    service = module.get<SchemaParserService>(SchemaParserService);
    openAPIParser = module.get<OpenAPIParserService>(OpenAPIParserService);
    graphQLParser = module.get<GraphQLParserService>(GraphQLParserService);
    soapParser = module.get<SOAPParserService>(SOAPParserService);
    protobufParser = module.get<ProtobufParserService>(ProtobufParserService);
  });

  describe('getParserForApiType', () => {
    it('should return correct parser for each API type', () => {
      expect(service.getParserForApiType(ApiType.OPENAPI)).toBe(openAPIParser);
      expect(service.getParserForApiType(ApiType.GRAPHQL)).toBe(graphQLParser);
      expect(service.getParserForApiType(ApiType.SOAP)).toBe(soapParser);
      expect(service.getParserForApiType(ApiType.GRPC)).toBe(protobufParser);
    });

    it('should throw for unsupported API type', () => {
      expect(() => service.getParserForApiType('UNKNOWN' as any))
        .toThrow('Unsupported API type');
    });
  });

  describe('parseApiSchema - Real parsing', () => {
    it('should parse OpenAPI schema and return parsed structure', async () => {
      const openAPISchema = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'test',
              responses: { '200': { description: 'OK' } }
            }
          }
        }
      });

      const parsed = await service.parseApiSchema(openAPISchema, ApiType.OPENAPI);

      expect(parsed).toBeDefined();
      expect(parsed.info).toBeDefined();
      expect(parsed.info.title).toBe('Test');
      expect(parsed.operations).toBeDefined();
      expect(Array.isArray(parsed.operations)).toBe(true);
    });

    it('should parse GraphQL schema', async () => {
      const graphQLSchema = `
        type Query {
          user(id: ID!): User
        }
        type User {
          id: ID!
          name: String!
        }
      `;

      const parsed = await service.parseApiSchema(graphQLSchema, ApiType.GRAPHQL);

      expect(parsed).toBeDefined();
      expect(parsed.info).toBeDefined();
      expect(parsed.operations).toBeDefined();
    });
  });

});
