import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { BullModule } from '@nestjs/bull';

import { ApisController } from './apis.controller';
import { ApisService } from './apis.service';
import { CredentialService } from './credential.service';

// Entities
import { Api } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Organization } from '../../entities/organization.entity';
import { Credential } from '../../entities/credential.entity';

// Modules
import { SchemaParserModule } from '../schema-parser/schema-parser.module';
import { ToolsModule } from '../tools/tools.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Api,
      ApiSchema,
      Operation,
      Resource,
      Organization,
      Credential,
    ]),
    BullModule.registerQueue({
      name: 'schema-import',
    }),
    MulterModule.register({
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max file size
      },
      fileFilter: (req, file, cb) => {
        // Accept JSON, YAML, XML, and text files
        const allowedMimeTypes = [
          'application/json',
          'application/yaml',
          'text/yaml',
          'application/x-yaml',
          'text/x-yaml',
          'application/xml',
          'text/xml',
          'text/plain',
        ];

        if (allowedMimeTypes.includes(file.mimetype) || 
            file.originalname.match(/\.(json|yaml|yml|xml|proto|wsdl|graphql|gql)$/)) {
          cb(null, true);
        } else {
          cb(new Error('Invalid file type. Only JSON, YAML, XML, Proto, WSDL, and GraphQL files are allowed.'), false);
        }
      },
    }),
    SchemaParserModule,
    ToolsModule,
  ],
  controllers: [ApisController],
  providers: [ApisService, CredentialService],
  exports: [ApisService, CredentialService],
})
export class ApisModule {}