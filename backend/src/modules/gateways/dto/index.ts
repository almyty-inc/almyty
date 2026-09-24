import { IsString, IsOptional, IsEnum, IsObject } from 'class-validator';
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
  @IsString()
  status?: string;

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