import { IsOptional, IsObject } from 'class-validator';

export class InvokeAgentDto {
  @IsOptional()
  @IsObject()
  input?: Record<string, any>;

  @IsOptional()
  @IsObject()
  variables?: Record<string, any>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
