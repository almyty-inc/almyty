import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Api } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';

import { SchemaParserService } from './schema-parser.service';
import { OpenAPIParserService } from './parsers/openapi-parser.service';
import { GraphQLParserService } from './parsers/graphql-parser.service';
import { SOAPParserService } from './parsers/soap-parser.service';
import { ProtobufParserService } from './parsers/protobuf-parser.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Api, ApiSchema, Operation, Resource]),
  ],
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