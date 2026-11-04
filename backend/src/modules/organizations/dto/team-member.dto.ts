import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TeamRole } from '../../../entities/user-team.entity';

export class AddTeamMemberDto {
  @ApiProperty({ description: 'The organization member to add to the team' })
  @IsUUID()
  userId: string;

  @ApiPropertyOptional({
    description: 'Role in the team; member when left out',
    enum: TeamRole,
    example: TeamRole.MEMBER,
  })
  @IsOptional()
  @IsEnum(TeamRole)
  role?: TeamRole;
}

export class UpdateTeamMemberRoleDto {
  @ApiProperty({ description: 'Role in the team', enum: TeamRole, example: TeamRole.LEAD })
  @IsEnum(TeamRole)
  role: TeamRole;
}
