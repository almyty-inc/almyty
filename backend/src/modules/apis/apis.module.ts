import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { BullModule } from '@nestjs/bull';

import { uploadLimits } from '../files/upload-limits';

import { ApisController } from './apis.controller';
import { ApisCredentialsController } from './apis-credentials.controller';
import { ApisService } from './apis.service';
import { ApisImportHelper } from './apis-import.helper';
import { ApisToolGeneratorHelper } from './apis-tool-generator.helper';
import { CredentialService } from './credential.service';
import { ApiConnectService } from './api-connect.service';
import { ApiKeyService } from './api-key.service';

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
import { AuthorizationModule } from '../../common/authorization/authorization.module';

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
      // 10 MB for the description, and a bound on the fields beside it.
      limits: uploadLimits(10 * 1024 * 1024),
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
    AuthorizationModule,
  ],
  controllers: [ApisController, ApisCredentialsController],
  providers: [ApisService, ApisImportHelper, ApisToolGeneratorHelper, CredentialService, ApiConnectService, ApiKeyService],
  exports: [ApisService, CredentialService],
})
export class ApisModule {}