import { IsEmail, IsString, MinLength, MaxLength, IsNotEmpty, IsOptional, IsObject } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

import { stripHtmlTransform as stripHtml } from '../../../common/security/strip-tags';
import { SignupAttribution, sanitizeSignupAttribution } from '../../product-analytics/signup-attribution';

export class CreateUserDto {
  @ApiProperty({
    description: 'User email address',
    example: 'user@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'User password (minimum 8 characters)',
    example: 'SecurePassword123!',
    minLength: 8,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @IsNotEmpty()
  password: string;

  @ApiProperty({
    description: 'User first name',
    example: 'John',
  })
  @Transform(stripHtml)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({
    description: 'User last name',
    example: 'Doe',
  })
  @Transform(stripHtml)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({
    description: 'Organization name (must be unique)',
    example: 'Acme Corporation',
  })
  @Transform(stripHtml)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @IsNotEmpty()
  organizationName: string;

  @ApiProperty({
    description:
      'CAPTCHA response token (Cloudflare Turnstile / hCaptcha). Only required when CAPTCHA is enabled server-side; ignored otherwise.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  captchaToken?: string;

  @ApiProperty({
    description:
      'Where the sign-up came from: the utm_source, utm_medium, utm_campaign, utm_content and cta values of the link into the register page. Each value is cut to 100 characters; other keys, and values that are not plain identifiers, are dropped.',
    required: false,
    example: { utm_source: 'almyty.com', utm_medium: 'website', utm_campaign: 'launch', cta: 'hero' },
  })
  @IsOptional()
  @Transform(({ value }) => sanitizeSignupAttribution(value) ?? undefined)
  @IsObject()
  attribution?: SignupAttribution;
}