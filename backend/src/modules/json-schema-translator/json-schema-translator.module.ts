import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { JsonSchema } from '../../entities/json-schema.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';

import { JsonSchemaTranslatorService } from './json-schema-translator.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([JsonSchema, ApiSchema, Operation, Resource]),
  ],
  providers: [JsonSchemaTranslatorService],
  exports: [JsonSchemaTranslatorService],
})
export class JsonSchemaTranslatorModule {}