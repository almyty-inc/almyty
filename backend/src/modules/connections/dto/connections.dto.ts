import { ArrayMinSize, IsArray, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { CONNECT_METHOD_TYPES, CONNECTOR_KINDS, ConnectMethodType, ConnectorKind } from '../connector.types';

export class ConnectBodyDto {
  @IsOptional() @IsIn(CONNECT_METHOD_TYPES as readonly string[]) method?: ConnectMethodType;
  @IsOptional() @IsIn(['org', 'user']) owner?: 'org' | 'user';
  @IsOptional() @IsIn(['browser', 'headless']) mode?: 'browser' | 'headless';
  @IsOptional() @IsObject() input?: Record<string, unknown>;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
}

export class CompleteConnectDto {
  @IsString() @MinLength(16) @MaxLength(256) state: string;
  @IsString() @MinLength(1) @MaxLength(4096) code: string;
}

export class RotateBodyDto {
  @IsOptional() @IsObject() input?: Record<string, unknown>;
  @IsOptional() @IsIn(['browser', 'headless']) mode?: 'browser' | 'headless';
}

export class ListConnectorsQueryDto {
  @IsOptional() @IsIn(CONNECTOR_KINDS as readonly string[]) kind?: ConnectorKind;
}

/** Shape-checked here, semantics (methods, endpoints) by validateConnectorDefinition. */
export class CreateConnectorDto {
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{1,63}$/) key: string;
  @IsIn(CONNECTOR_KINDS as readonly string[]) kind: ConnectorKind;
  @IsString() @MinLength(1) @MaxLength(120) displayName: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsArray() @ArrayMinSize(1) connect: Record<string, unknown>[];
  @IsObject() validation: Record<string, unknown>;
  @IsOptional() @IsObject() revoke?: Record<string, unknown>;
  @IsOptional() @IsArray() @IsString({ each: true }) capabilities?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) scopesNeeded?: string[];
  @IsOptional() @IsString() @MaxLength(64) pricingSource?: string;
  @IsOptional() @IsString() @MaxLength(2048) keyPageUrl?: string;
  @IsOptional() @IsString() @MaxLength(2048) docsUrl?: string;
}
