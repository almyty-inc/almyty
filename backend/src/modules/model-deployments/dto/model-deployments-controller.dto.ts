import { IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateModelDeploymentBodyDto {
  @IsUUID()
  modelVersionId: string;

  @IsString()
  @MaxLength(64)
  providerType: string;

  @IsOptional()
  @IsObject()
  desired?: Record<string, any>;

  @IsOptional()
  @IsObject()
  providerConfig?: Record<string, any>;

  @IsOptional()
  @IsUUID()
  credentialId?: string;

  @IsOptional()
  @IsUUID()
  budgetId?: string;

  @IsOptional()
  @IsUUID()
  modelId?: string;
}

export class ScaleModelDeploymentBodyDto {
  @IsInt()
  @Min(0)
  replicas: number;
}
