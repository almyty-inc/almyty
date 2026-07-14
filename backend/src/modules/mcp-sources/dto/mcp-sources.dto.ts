import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateMcpSourceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  url: string;

  @IsOptional()
  @IsIn(['none', 'bearer', 'headers'])
  authType?: 'none' | 'bearer' | 'headers';

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  bearerToken?: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;
}
