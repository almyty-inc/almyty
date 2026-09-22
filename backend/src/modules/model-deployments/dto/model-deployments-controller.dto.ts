import { IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateModelDeploymentBodyDto {
  /**
   * Where the model is: an artifact with a pin (hf://org/repo@sha,
   * s3://bucket/prefix@etag, gs://..., file:///path@sha) or a model
   * already on a platform (bedrock://, fireworks://, together://, ...).
   * The service parses it and refuses one the adapter cannot read.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  model?: string;

  /** Architecture family, when the reference carries no manifest to read it from. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  base?: string;

  /**
   * Optional: a registered artifact, for lineage and evaluation history.
   * Naming the model is configuration, so most deployments have none. The
   * service refuses a body that carries neither this nor `model`.
   */
  @IsOptional()
  @IsUUID()
  modelVersionId?: string;

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
