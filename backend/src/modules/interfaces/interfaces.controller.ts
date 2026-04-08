import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Headers, Sse, Req,
  UseGuards, Request, ParseUUIDPipe, HttpStatus, HttpException, Logger, MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Observable, Subject } from 'rxjs';
import { InterfacesService } from './interfaces.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { InterfaceType, InterfaceStatus } from '../../entities/interface.entity';
import { AgentRuntimeService } from '../agents/agent-runtime.service';

@Controller('interfaces')
@ApiTags('Interfaces')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class InterfacesController {
  private readonly logger = new Logger(InterfacesController.name);

  constructor(
    private readonly interfacesService: InterfacesService,
    private readonly agentRuntimeService: AgentRuntimeService,
  ) {}

  private getOrgId(req: any): string {
    const organizationId = req.user.currentOrganizationId;
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

  // ---------------------------------------------------------------------------
  // Inbound webhook (external platforms: Slack, Discord, Telegram, etc.)
  // ---------------------------------------------------------------------------

  @Post(':id/webhook')
  @Public()
  async handleWebhook(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: any,
    @Headers() headers: Record<string, string>,
  ) {
    try {
      // Slack URL verification challenge
      if (body.type === 'url_verification') {
        return { challenge: body.challenge };
      }

      // Fire-and-forget: process the inbound message asynchronously
      this.interfacesService.handleInboundMessage(id, body, headers).catch((err) => {
        this.logger.error(`Webhook processing failed for interface ${id}: ${err.message}`, err.stack);
      });

      // Return 200 immediately so the external platform doesn't retry
      return { ok: true };
    } catch (error) {
      this.logger.error(`Webhook error for interface ${id}: ${error.message}`);
      throw new HttpException(
        { success: false, message: error.message, error: 'WEBHOOK_FAILED' },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Widget endpoints (chat widget embeds)
  // ---------------------------------------------------------------------------

  @Post('widget/:interfaceId/message')
  @Public()
  async widgetMessage(
    @Param('interfaceId', ParseUUIDPipe) interfaceId: string,
    @Body() body: { message: string; sessionId?: string; threadId?: string },
  ) {
    try {
      const result = await this.interfacesService.handleWidgetMessage(interfaceId, body);
      return { success: true, data: result };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'WIDGET_MESSAGE_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Sse('widget/:interfaceId/stream/:runId')
  @Public()
  widgetStream(
    @Param('interfaceId', ParseUUIDPipe) interfaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Observable<MessageEvent> {
    const subject = new Subject<MessageEvent>();

    // Validate interface exists and is active, then subscribe to run events
    this.interfacesService
      .findByIdPublic(interfaceId)
      .then((iface) => {
        if (!iface || !iface.isActive()) {
          subject.next({ data: { error: 'Interface not found or inactive' } } as MessageEvent);
          subject.complete();
          return;
        }

        const emitter = this.agentRuntimeService.getRunEmitter(runId);
        if (!emitter) {
          subject.next({ data: { error: 'Run not found or already completed' } } as MessageEvent);
          subject.complete();
          return;
        }

        const onEvent = (event: any) => {
          subject.next({ data: event } as MessageEvent);
        };
        const onDone = () => {
          subject.complete();
          cleanup();
        };
        const cleanup = () => {
          emitter.removeListener('event', onEvent);
          emitter.removeListener('done', onDone);
        };

        emitter.on('event', onEvent);
        emitter.on('done', onDone);
      })
      .catch((err) => {
        this.logger.error(`Widget stream error: ${err.message}`);
        subject.next({ data: { error: 'Stream setup failed' } } as MessageEvent);
        subject.complete();
      });

    return subject.asObservable();
  }
}
