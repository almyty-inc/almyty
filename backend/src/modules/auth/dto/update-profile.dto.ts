import { IsString, IsEmail, IsOptional, IsTimeZone, MinLength, MaxLength, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { stripHtmlTransform as stripHtml } from '../../../common/security/strip-tags';

export class UpdateProfileDto {
  @ApiPropertyOptional({
    description: 'User full name (will be split into firstName and lastName)',
    example: 'John Doe',
  })
  @Transform(stripHtml)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'User email address',
    example: 'john.doe@example.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'Current password. Required to change the email address.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  currentPassword?: string;

  @ApiPropertyOptional({
    description: 'Your time zone, an IANA name such as Europe/Berlin. Emails sent at a time of day use it; null means UTC.',
    example: 'Europe/Berlin',
  })
  @IsOptional()
  @ValidateIf((o) => o.timezone !== null)
  @IsTimeZone()
  timezone?: string | null;
}