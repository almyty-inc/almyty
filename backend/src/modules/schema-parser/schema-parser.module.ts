import { Module } from '@nestjs/common';

import { SchemaParserService } from './schema-parser.service';
import { OpenAPIParserService } from './parsers/openapi-parser.service';
import { GraphQLParserService } from './parsers/graphql-parser.service';
import { SOAPParserService } from './parsers/soap-parser.service';
import { ProtobufParserService } from './parsers/protobuf-parser.service';

/**
 * Parsing only. Nothing here touches the database: the service picks a
 * parser and runs it, and none of the four parsers injects a
 * repository. The `TypeOrmModule.forFeature([Api, ApiSchema, Operation,
 * Resource])` this module used to declare existed for the persistence
 * methods on the service, which had no callers and are gone —
 * `apis-import.helper.ts` owns the writes, which is where the
 * transaction and the idempotency live.
 */
@Module({
  providers: [
    SchemaParserService,
    OpenAPIParserService,
    GraphQLParserService,
    SOAPParserService,
    ProtobufParserService,
  ],
  exports: [SchemaParserService],
})
export class SchemaParserModule {}
