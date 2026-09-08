import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, IsUrl, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const PRIVACY_TIERS = ['local', 'private_cloud', 'public'] as const;
const STATUSES = ['active', 'inactive', 'error', 'deploying'] as const;

export class ModelPricingDto {
  @Min(0) inPerMTok: number;
  @Min(0) outPerMTok: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
}

export class RegisterModelBodyDto {
  @IsString() @MaxLength(255) name: string;
  @IsString() @MaxLength(255) vendorModelId: string;
  @IsOptional() @IsUUID() providerId?: string;
  @IsOptional() @IsObject() endpointRef?: Record<string, any>;
  @IsOptional() @IsUUID() modelVersionId?: string;
  @IsOptional() @IsObject() capabilities?: Record<string, boolean>;
  @IsOptional() @IsInt() @Min(1) contextLength?: number;
  @IsOptional() @IsIn(PRIVACY_TIERS) privacyTier?: (typeof PRIVACY_TIERS)[number];
  @IsOptional() @IsString() @MaxLength(64) region?: string;
  @IsOptional() @ValidateNested() @Type(() => ModelPricingDto) pricingOverride?: ModelPricingDto;
  @IsOptional() @IsString() @MaxLength(255) base?: string;
  @IsOptional() @IsObject() metadata?: Record<string, any>;
}

export class RegisterEndpointBodyDto {
  @IsString() @MaxLength(255) name: string;
  @IsUrl({ require_tld: false, require_protocol: true }) url: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsString() @MaxLength(255) vendorModelId: string;
  @IsOptional() @IsObject() capabilities?: Record<string, boolean>;
  @IsOptional() @IsInt() @Min(1) contextLength?: number;
  @IsOptional() @IsIn(PRIVACY_TIERS) privacyTier?: (typeof PRIVACY_TIERS)[number];
  @IsOptional() @IsString() @MaxLength(64) region?: string;
  @IsOptional() @ValidateNested() @Type(() => ModelPricingDto) pricingOverride?: ModelPricingDto;
}

export class UpdateModelBodyDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsObject() capabilities?: Record<string, boolean>;
  @IsOptional() @IsInt() @Min(1) contextLength?: number | null;
  @IsOptional() @IsIn(PRIVACY_TIERS) privacyTier?: (typeof PRIVACY_TIERS)[number];
  @IsOptional() @IsString() @MaxLength(64) region?: string | null;
  @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  @IsOptional() @ValidateNested() @Type(() => ModelPricingDto) pricingOverride?: ModelPricingDto | null;
  @IsOptional() @IsUUID() modelVersionId?: string | null;
  @IsOptional() @IsString() @MaxLength(255) base?: string | null;
  @IsOptional() @IsObject() metadata?: Record<string, any> | null;
}

export class SyncModelsBodyDto {
  /** One provider; omit (or send no body) to sync every active provider of the org. */
  @IsOptional() @IsUUID() providerId?: string;
}

export class ListModelsQueryDto {
  @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  @IsOptional() @IsIn(PRIVACY_TIERS) privacyTier?: (typeof PRIVACY_TIERS)[number];
  @IsOptional() @IsUUID() providerId?: string;
  @IsOptional() @IsBoolean() @Type(() => Boolean) selectable?: boolean;
}
