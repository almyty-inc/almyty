import { IsString, IsOptional, IsUrl, MinLength, MaxLength, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationSettings } from '../../../entities/organization.entity';

export class CreateOrganizationDto {
  @ApiProperty({
    description: 'Organization name',
    example: 'Acme Corporation',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Organization URL slug (auto-generated if not provided)',
    example: 'acme-corp',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  slug?: string;

  @ApiPropertyOptional({
    description: 'Organization description',
    example: 'Leading provider of innovative solutions',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Organization website URL',
    example: 'https://acme.com',
  })
  @IsOptional()
  @IsUrl()
  website?: string;

  @ApiPropertyOptional({
    description: 'Organization logo URL',
    example: 'https://acme.com/logo.png',
  })
  @IsOptional()
  @IsUrl()
  logo?: string;

  @ApiPropertyOptional({
    description: 'Organization settings',
    example: {
      maxApis: 10,
      maxTools: 100,
      defaultRateLimit: { ttl: 60, limit: 100 }
    },
  })
  @IsOptional()
  @IsObject()
  settings?: OrganizationSettings;
}