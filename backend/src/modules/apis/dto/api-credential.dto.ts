import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { CredentialType } from '../../../entities/credential.entity';

/**
 * The bodies for /apis/:id/credentials.
 *
 * These were the `CreateCredentialDto` / `UpdateCredentialDto`
 * interfaces exported from credential.service.ts. An interface erases at
 * compile time, so Nest saw `Object` as the parameter metatype and the
 * global ValidationPipe skipped the body altogether -- on the endpoint
 * that stores an API's secret. A POST with no `name` reached
 * `credentialRepository.save()` and came back as a driver 500 instead of
 * a 400, `type` was never checked against CredentialType, and the
 * app-wide whitelist/forbidNonWhitelisted policy did not apply.
 *
 * The convenience fields (headerName/headerValue/username/password/
 * token) are the flat alternative to `config` that
 * CredentialService.createCredential() folds into it, and are declared
 * here so the whitelist does not strip them.
 */
export class CreateApiCredentialBodyDto {
  @ApiProperty({ description: 'Display name for the credential' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ enum: CredentialType })
  @IsEnum(CredentialType)
  type: CredentialType;

  @ApiPropertyOptional({ description: 'The secret material; encrypted before it is stored' })
  @IsOptional()
  @IsObject()
  config?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Flat alternative to config, for an api_key header' })
  @IsOptional()
  @IsString()
  headerName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  headerValue?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  token?: string;

  @ApiPropertyOptional({ description: 'Name of the parameter carrying the key' })
  @IsOptional()
  @IsString()
  keyName?: string;

  @ApiPropertyOptional({ description: 'Where the key goes: header, query, ...' })
  @IsOptional()
  @IsString()
  keyLocation?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({ description: 'ISO 8601 expiry' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

/**
 * The PUT body. Deliberately not `PartialType(CreateApiCredentialBodyDto)`:
 * `type` is not updatable here (updateCredential never reads it), and the
 * flat convenience fields only exist on the create path, so accepting
 * them on update would be accepting input the service drops.
 */
export class UpdateApiCredentialBodyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  config?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  keyName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  keyLocation?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'ISO 8601 expiry; empty string or null clears it' })
  @IsOptional()
  @IsString()
  expiresAt?: string;
}
