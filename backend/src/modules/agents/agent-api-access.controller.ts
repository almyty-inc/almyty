import { Controller, Get, Post, Param, Body, Request, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AgentApiAccessService } from './agent-api-access.service';
import { ACCESS_SCOPES, type AccessScope } from '../gateways/gateway-access';
class AgentApiAccessBody {
 @IsIn(ACCESS_SCOPES) accessScope: AccessScope;
 @IsOptional() @IsUUID() accessTeamId?: string | null;
}
@Controller('agents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentApiAccessController {
 constructor(private readonly access: AgentApiAccessService) {}
 @Get(':id/api-access')
 @Roles('member', 'admin', 'owner')
 async get(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) { return { success: true, data: await this.access.get(id, req.user.currentOrganizationId, req.user.id) }; }
 @Post(':id/api-access')
 @Roles('member', 'admin', 'owner')
 async set(@Param('id', ParseUUIDPipe) id: string, @Body() body: AgentApiAccessBody, @Request() req: any) { return { success: true, data: await this.access.set(id, req.user.currentOrganizationId, req.user.id, body) }; }
}
