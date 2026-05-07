import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  HttpException,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceService, CreateWorkspaceInput } from './workspace.service';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly service: WorkspaceService) {}

  @Post()
  async create(@Request() req: any, @Body() body: CreateWorkspaceInput) {
    const { ownerUserId, organizationId } = ctx(req);
    const data = await this.service.create(body, ownerUserId, organizationId);
    return { success: true, data };
  }

  @Get()
  async list(@Request() req: any) {
    const { ownerUserId, organizationId } = ctx(req);
    const data = await this.service.listForOwner(ownerUserId, organizationId);
    return { success: true, data };
  }

  @Get(':id')
  async getOne(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const { ownerUserId, organizationId } = ctx(req);
    const data = await this.service.getOne(id, ownerUserId, organizationId);
    return { success: true, data };
  }

  @Delete(':id')
  async release(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const { ownerUserId, organizationId } = ctx(req);
    const data = await this.service.release(id, ownerUserId, organizationId);
    return { success: true, data };
  }
}

function ctx(req: any): { ownerUserId: string; organizationId: string } {
  const ownerUserId = req.user?.id;
  const organizationId = req.user?.currentOrganizationId;
  if (!ownerUserId || !organizationId) {
    throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
  }
  return { ownerUserId, organizationId };
}
