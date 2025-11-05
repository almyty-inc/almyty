import { IsString, IsOptional, IsArray, IsDateString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class RateLimitDto {
  @ApiPropertyOptional({
    description: 'Requests per minute limit',
    example: 60,
  })
  @IsOptional()
  requestsPerMinute?: number;

  @ApiPropertyOptional({
    description: 'Requests per hour limit',
    example: 1000,
  })
  @IsOptional()
  requestsPerHour?: number;

  @ApiPropertyOptional({
    description: 'Requests per day limit',
    example: 10000,
  })
  @IsOptional()
  requestsPerDay?: number;
}

export class CreateApiKeyDto {
  @ApiProperty({
    description: 'API key name/description',
    example: 'Production API Key',
  })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description: 'Organization ID to associate with this API key',
    example: 'org-123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'Array of scopes/permissions for this API key',
    example: ['read', 'write', 'admin'],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({
    description: 'API key expiration date',
    example: '2024-12-31T23:59:59.000Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: Date;

  @ApiPropertyOptional({
    description: 'Rate limiting configuration',
    type: RateLimitDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => RateLimitDto)
  rateLimits?: RateLimitDto;

  @ApiPropertyOptional({
    description: 'Additional metadata for the API key',
    example: { environment: 'production', project: 'main' },
  })
  @IsOptional()
  metadata?: Record<string, any>;
}