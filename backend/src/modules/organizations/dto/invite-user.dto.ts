import { IsEmail, IsEnum, IsOptional, IsArray, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationRole } from '../../../entities/user-organization.entity';

export class InviteUserDto {
  @ApiProperty({
    description: 'User email address',
    example: 'user@example.com',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'Role to assign to the user',
    enum: OrganizationRole,
    example: OrganizationRole.MEMBER,
  })
  @IsEnum(OrganizationRole)
  role: OrganizationRole;

  @ApiPropertyOptional({
    description: 'Additional permissions to grant',
    example: ['read_apis', 'create_tools'],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}