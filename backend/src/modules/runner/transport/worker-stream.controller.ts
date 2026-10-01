import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Request,
  Response,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { WorkerStreamTransport } from './worker-stream.transport';

/**
 * Where a runner daemon talks to the backend: `POST` sends envelopes,
 * `GET` holds the server -> runner stream (WorkerStreamTransport).
 *
 * `/runners/stream` is the route. `/mcp/streamable` is the route runners
 * used while this channel shared the MCP transport; it is kept, envelopes
 * only, for one runner release so an installed runner keeps connecting
 * (docs/design/mcp-2026-07-28.md, decision 3). New runners try
 * `/runners/stream` first and fall back on a 404.
 *
 * Every handler carries RolesGuard AND @Roles: the guard alone is inert,
 * and a viewer must not hold a runner session.
 */
@Controller()
export class WorkerStreamController {
  constructor(private readonly stream: WorkerStreamTransport) {}

  private context(req: any): { organizationId: string; userId?: string } {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    return { organizationId, userId: req.user?.id };
  }

  @Post('runners/stream')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async post(@Request() req, @Response() res): Promise<void> {
    const { organizationId, userId } = this.context(req);
    await this.stream.handlePost(req, res, organizationId, userId);
  }

  @Get('runners/stream')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async open(@Request() req, @Response() res): Promise<void> {
    const { organizationId, userId } = this.context(req);
    await this.stream.handleStream(req, res, organizationId, userId);
  }

  /** The pre-split route, envelopes only, for runners installed before it. */
  @Post('mcp/streamable')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async legacyPost(@Request() req, @Response() res): Promise<void> {
    const { organizationId, userId } = this.context(req);
    await this.stream.handlePost(req, res, organizationId, userId);
  }

  @Get('mcp/streamable')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('member', 'admin', 'owner')
  async legacyOpen(@Request() req, @Response() res): Promise<void> {
    const { organizationId, userId } = this.context(req);
    await this.stream.handleStream(req, res, organizationId, userId);
  }
}
