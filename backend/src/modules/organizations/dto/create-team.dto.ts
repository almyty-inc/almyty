import { IsString, IsOptional, MinLength, MaxLength, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTeamDto {
  @ApiProperty({
    description: 'Team name',
    example: 'Development Team',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Team description',
    example: 'Backend development team',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Team settings',
    example: { notifications: true, permissions: ['read', 'write'] },
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, any>;
}