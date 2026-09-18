import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  UsePipes,
  ValidationPipe,
  Request,
  ParseUUIDPipe,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ExternalAgentsService } from './external-agents.service';
import {
  PreviewExternalAgentDto,
  CreateExternalAgentDto,
  UpdateExternalAgentDto,
} from './dto/external-agent.dto';

@Controller('external-agents')
// Was JwtAuthGuard-only, so a `viewer` (permissions ['read',
// 'connections:read']) could create, repoint, refresh or delete an external
// agent. Repointing one's URL is a data-exfiltration primitive: the org's own
// agents then call an attacker-chosen endpoint with whatever they pass it.
// Roles mirror the dashboard sibling agents.controller.ts -- reads at viewer+,
// create/update/delete at member+ -- with the two routes that fetch a remote
// URL server-side (preview, refresh) held at member+ as well.
//
// RolesGuard returns true when neither @Roles nor @Permissions is present, so
// the guard is inert without the per-route decorator.
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExternalAgentsController {
  constructor(private readonly externalAgentsService: ExternalAgentsService) {}

  private requireOrg(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        {
          success: false,
          message: 'Organization context required.',
          error: 'NO_ORGANIZATION',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  @Post('preview')
  @Roles('member', 'admin', 'owner')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async preview(@Request() req: any, @Body() body: PreviewExternalAgentDto) {
    const orgId = this.requireOrg(req);
    const userId = req.user?.id;
    const data = await this.externalAgentsService.importFromUrl(orgId, userId, body.url);
    return { success: true, data };
  }

  @Post()
  @Roles('member', 'admin', 'owner')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async create(@Request() req: any, @Body() body: CreateExternalAgentDto) {
    const orgId = this.requireOrg(req);
    const agent = await this.externalAgentsService.create(orgId, body);
    return { success: true, data: agent };
  }

  @Get()
  @Roles('viewer', 'member', 'admin', 'owner')
  async findAll(@Request() req: any) {
    const orgId = this.requireOrg(req);
    const agents = await this.externalAgentsService.findAll(orgId);
    return { success: true, data: agents };
  }

  @Get(':id')
  @Roles('viewer', 'member', 'admin', 'owner')
  async findOne(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const orgId = this.requireOrg(req);
    const agent = await this.externalAgentsService.findById(id, orgId);
    return { success: true, data: agent };
  }

  @Patch(':id')
  @Roles('member', 'admin', 'owner')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async update(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateExternalAgentDto,
  ) {
    const orgId = this.requireOrg(req);
    const agent = await this.externalAgentsService.update(id, orgId, body as any);
    return { success: true, data: agent };
  }

  @Delete(':id')
  @Roles('member', 'admin', 'owner')
  async remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const orgId = this.requireOrg(req);
    await this.externalAgentsService.delete(id, orgId);
    return { success: true };
  }

  @Post(':id/refresh')
  @Roles('member', 'admin', 'owner')
  async refresh(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const orgId = this.requireOrg(req);
    const agent = await this.externalAgentsService.refreshCard(id, orgId);
    return { success: true, data: agent };
  }
}
