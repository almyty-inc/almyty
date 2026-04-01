import { IsString, IsOptional, IsUrl, MinLength, MaxLength, IsObject } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationSettings } from '../../../entities/organization.entity';

const stripHtml = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim() : value;

export class CreateOrganizationDto {
  @ApiProperty({
    description: 'Organization name',
    example: 'Acme Corporation',
  })
  @Transform(stripHtml)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Organization URL slug (auto-generated if not provided)',
    example: 'acme-corp',
  })
  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  slug?: string;

  @ApiPropertyOptional({
    description: 'Organization description',
    example: 'Leading provider of innovative solutions',
  })
  @Transform(stripHtml)
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

  @ApiPropertyOptional({
    description: 'Default agent configuration applied to all agents in this organization',
    example: {
      personality: 'Be professional and concise.',
      rules: 'Never share internal data.',
      maxCostPerRun: 100,
      maxStepsPerRun: 50,
    },
  })
  @IsOptional()
  @IsObject()
  agentDefaults?: {
    personality?: string;
    rules?: string;
    maxCostPerRun?: number;
    maxStepsPerRun?: number;
  };
}