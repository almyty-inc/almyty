import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Publish an existing tool into the hub.
 *
 * There is deliberately no `organizationId` here. Ownership is taken from
 * the caller's validated current organization; accepting it from the body
 * would let any member publish into -- or overwrite -- another tenant's
 * catalog, and a null would publish to every tenant at once.
 */
export class PublishToolTemplateDto {
  @IsUUID()
  toolId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  category: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  provider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  providerIcon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'version must be semver, e.g. 1.0.0' })
  version?: string;
}

/**
 * Metadata-only edit of a template the caller's organization owns. The
 * request shape, `httpConfig` and `parameters` are not editable here:
 * they come from a tool, and changing them by hand would let a template
 * drift from anything that was ever verified to work. Republish instead.
 */
export class UpdateToolTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  provider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  providerIcon?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^\d+\.\d+\.\d+$/, { message: 'version must be semver, e.g. 1.0.0' })
  version?: string;
}
