import { Injectable, BadRequestException, Logger } from '@nestjs/common';

import { ApiType } from '../../entities/api.entity';

import { OpenAPIParserService } from './parsers/openapi-parser.service';
import { GraphQLParserService } from './parsers/graphql-parser.service';
import { SOAPParserService } from './parsers/soap-parser.service';
import { ProtobufParserService } from './parsers/protobuf-parser.service';

import { SchemaParser, ParsedSchema } from './interfaces/parser.interface';

/**
 * Picks the parser for an API type and runs it.
 *
 * That is the whole job. This used to be 334 lines: `parseAndStore`,
 * `reparse`, `validateSchemaString`, `getSchemaPreview` and two
 * `extract*FromParsedSchema` methods, none of which had a single
 * production caller — the import path does its own persistence in
 * `apis-import.helper.ts`, which is where transaction boundaries and
 * idempotency belong. `parseAndStore` in particular had fourteen spec
 * blocks testifying to code nothing could reach, which is what kept it
 * looking alive.
 *
 * The three repository injections went with them: they were only ever
 * touched by `parseAndStore` and `reparse`, so a service that stores
 * nothing no longer asks for a way to store things.
 */
@Injectable()
export class SchemaParserService {
  private readonly logger = new Logger(SchemaParserService.name);

  constructor(
    private openAPIParser: OpenAPIParserService,
    private graphQLParser: GraphQLParserService,
    private soapParser: SOAPParserService,
    private protobufParser: ProtobufParserService,
  ) {}

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

  async parseApiSchema(
    rawSchema: string,
    apiType: ApiType,
    fileName?: string,
  ): Promise<ParsedSchema> {
    const parser = this.getParserForApiType(apiType);
    return parser.parseSchema(rawSchema, fileName);
  }
}
