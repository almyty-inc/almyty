import { IsString, IsOptional, IsEnum, IsObject, IsNumber, IsUrl, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { GatewayType } from '../../../entities/gateway.entity';

export class CreateGatewayDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(GatewayType)
  type: GatewayType;

  @IsString()
  endpoint: string;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @IsOptional()
  @IsObject()
  rateLimits?: Record<string, any>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class UpdateGatewayDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  endpoint?: string;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @IsOptional()
  @IsObject()
  rateLimits?: Record<string, any>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}