import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, Request, ParseUUIDPipe, HttpStatus, HttpException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { InterfacesService } from './interfaces.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { InterfaceType, InterfaceStatus } from '../../entities/interface.entity';

@Controller('interfaces')
@ApiTags('Interfaces')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class InterfacesController {
  private readonly logger = new Logger(InterfacesController.name);

  constructor(private readonly interfacesService: InterfacesService) {}

  private getOrgId(req: any): string {
    const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
    if (!organizationId) {
      throw new HttpException(
        { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  @Get()
  @Roles('viewer', 'member', 'admin', 'owner')
  async findAll(@Query('agentId') agentId: string, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const data = await this.interfacesService.findAll(organizationId, agentId);
      return { success: true, data };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'INTERFACES_FETCH_FAILED' }, error.status || HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post()
  @Roles('admin', 'owner')
  async create(@Body() body: {
    agentId: string;
    type: InterfaceType;
    name: string;
    configuration?: Record<string, any>;
  }, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const iface = await this.interfacesService.create(organizationId, body);
      return { success: true, data: iface, message: 'Interface created successfully' };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'INTERFACE_CREATE_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }

  @Get(':id')
  @Roles('viewer', 'member', 'admin', 'owner')
  async findById(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const iface = await this.interfacesService.findById(id, organizationId);
      return { success: true, data: iface };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'INTERFACE_FETCH_FAILED' }, error.status || HttpStatus.NOT_FOUND);
    }
  }

  @Patch(':id')
  @Roles('admin', 'owner')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: Partial<{
    name: string;
    status: InterfaceStatus;
    configuration: Record<string, any>;
  }>, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const iface = await this.interfacesService.update(id, organizationId, body);
      return { success: true, data: iface, message: 'Interface updated successfully' };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'INTERFACE_UPDATE_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }

  @Delete(':id')
  @Roles('admin', 'owner')
  async remove(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      await this.interfacesService.remove(id, organizationId);
      return { success: true, message: 'Interface deleted successfully' };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'INTERFACE_DELETE_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }

  @Post(':id/activate')
  @Roles('admin', 'owner')
  async activate(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const iface = await this.interfacesService.activate(id, organizationId);
      return { success: true, data: iface, message: 'Interface activated' };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'INTERFACE_ACTIVATE_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }

  @Post(':id/deactivate')
  @Roles('admin', 'owner')
  async deactivate(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.getOrgId(req);
      const iface = await this.interfacesService.deactivate(id, organizationId);
      return { success: true, data: iface, message: 'Interface deactivated' };
    } catch (error) {
      throw new HttpException({ success: false, message: error.message, error: 'INTERFACE_DEACTIVATE_FAILED' }, error.status || HttpStatus.BAD_REQUEST);
    }
  }
}
