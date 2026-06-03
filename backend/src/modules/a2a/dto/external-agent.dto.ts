import {
  IsOptional,
  IsObject,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  IsNotEmpty,
} from 'class-validator';

export class PreviewExternalAgentDto {
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  url!: string;
}

export class CreateExternalAgentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  agentCardUrl!: string;

  @IsOptional()
  @IsObject()
  cachedCard?: Record<string, any>;

  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  baseRpcUrl?: string;

  @IsOptional()
  @IsUUID()
  credentialId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  selectedSecurityScheme?: string;
}

export class UpdateExternalAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  agentCardUrl?: string;

  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  baseRpcUrl?: string;

  @IsOptional()
  @IsUUID()
  credentialId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  selectedSecurityScheme?: string;
}
