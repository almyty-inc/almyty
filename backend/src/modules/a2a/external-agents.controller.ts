import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  ParseUUIDPipe,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ExternalAgentsService } from './external-agents.service';

@Controller('external-agents')
@UseGuards(JwtAuthGuard)
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
  async preview(@Request() req: any, @Body() body: { url: string }) {
    const orgId = this.requireOrg(req);
    const userId = req.user?.id;
    const data = await this.externalAgentsService.importFromUrl(orgId, userId, body.url);
    return { success: true, data };
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    const orgId = this.requireOrg(req);
    const agent = await this.externalAgentsService.create(orgId, body);
    return { success: true, data: agent };
  }

  @Get()
  async findAll(@Request() req: any) {
    const orgId = this.requireOrg(req);
    const agents = await this.externalAgentsService.findAll(orgId);
    return { success: true, data: agents };
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const orgId = this.requireOrg(req);
    const agent = await this.externalAgentsService.findById(id, orgId);
    return { success: true, data: agent };
  }

  @Patch(':id')
  async update(
    @Request() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: any,
  ) {
    const orgId = this.requireOrg(req);
    const agent = await this.externalAgentsService.update(id, orgId, body);
    return { success: true, data: agent };
  }

  @Delete(':id')
  async remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const orgId = this.requireOrg(req);
    await this.externalAgentsService.delete(id, orgId);
    return { success: true };
  }

  @Post(':id/refresh')
  async refresh(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const orgId = this.requireOrg(req);
    const agent = await this.externalAgentsService.refreshCard(id, orgId);
    return { success: true, data: agent };
  }
}
