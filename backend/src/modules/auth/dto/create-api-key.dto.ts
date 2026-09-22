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
    description: 'API key expiration date, ISO 8601',
    example: '2024-12-31T23:59:59.000Z',
  })
  @IsOptional()
  @IsDateString()
  // A string, because that is what arrives and what @IsDateString
  // accepts. It was declared `Date` with no @Type(() => Date), so
  // class-transformer left the string in place and the service assigned
  // it straight to a `timestamp` column: the row was right, but the
  // object handed back from createApiKey carried a string where every
  // read path carries a Date, and ApiKey.isExpired() compares it with
  // `new Date() > this.expiresAt` -- a Date-vs-string comparison that
  // silently degrades to a lexicographic one.
  expiresAt?: string;

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