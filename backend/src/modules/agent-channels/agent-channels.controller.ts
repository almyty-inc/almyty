import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AppBuild } from '../../entities/app-build.entity';
import { maskChannelConfigSecrets } from '../gateways/channels/channel-config.helper';
import { AgentChannelsService, Caller } from './agent-channels.service';
import { AppBuildsService } from './app-builds.service';
import {
  AddChannelBodyDto,
  PublicSettingsBodyDto,
  RecordBuildBodyDto,
  RequestBuildBodyDto,
  UpdateChannelBodyDto,
  VisitorDataRequestBodyDto,
} from './dto/agent-channels-controller.dto';
import { platformsFor, signingRequirementFor } from './build-targets';
import { downloadedFilename, handoffFor } from './build-handoff';
import { effectiveBranding } from './channel-rules';
import { VisitorDataRequestsService } from './visitor-data-requests.service';

/**
 * A channel as the API shows it. Its configuration may still hold a
 * platform key inline on a row the backfill has not moved, the same
 * values a gateway masks on every response, so it is never returned
 * verbatim. A masked placeholder sent back is dropped on save.
 */
export function publicChannel<T extends { configuration?: Record<string, any> | null }>(channel: T): T {
  if (!channel?.configuration) return channel;
  return { ...channel, configuration: maskChannelConfigSecrets(channel.configuration) };
}

/**
 * A build as the API shows it: without the toolchain log, which is raw
 * tool output full of build-host paths. The operator gets `error` and
 * `signingNote`, which are written for them.
 */
export function publicBuild<T extends Partial<Pick<AppBuild, 'log'>>>(build: T): Omit<T, 'log'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { log, ...rest } = build;
  return rest;
}

/**
 * An agent's channels and the public settings they inherit.
 *
 * The agent's Channels tab is the only place channels are added and
 * edited, and this is its API. Reading is open to members who can read
 * the agent; writing needs an admin or owner who can also manage the
 * agent, because it decides who may talk to it, what they may cost, and
 * what a download may do on the machine it lands on.
 */
@Controller('agents')
@ApiTags('Agent channels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentChannelsController {
  constructor(
    private readonly channels: AgentChannelsService,
    private readonly builds: AppBuildsService,
    // Required: Nest always injects it. Typed optional only so positional
    // unit specs that never answer a data request can leave it out.
    private readonly visitorRequests?: VisitorDataRequestsService,
  ) {}

  private org(req: any): string {
    return req.user.currentOrganizationId;
  }

  private caller(req: any): Caller {
    return { id: req.user.id };
  }

  private requests(): VisitorDataRequestsService {
    if (!this.visitorRequests) throw new ServiceUnavailableException('Data requests are not available here.');
    return this.visitorRequests;
  }

  // ─── Public settings ─────────────────────────────────────────────────

  @Get(':agentId/public-settings')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: "The branding and visitor rules every channel of this agent inherits" })
  async publicSettings(@Param('agentId', ParseUUIDPipe) agentId: string, @Request() req: any) {
    return { success: true, data: await this.channels.publicSettings(this.org(req), agentId, this.caller(req)) };
  }

  @Patch(':agentId/public-settings')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: "Change the branding and visitor rules this agent's channels inherit" })
  async updatePublicSettings(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: PublicSettingsBodyDto,
    @Request() req: any,
  ) {
    return {
      success: true,
      data: await this.channels.updatePublicSettings(this.org(req), agentId, this.caller(req), body as any),
    };
  }

  @Get(':agentId/public-settings/spend')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: "What this agent's channels have spent against their spend limits" })
  async spend(@Param('agentId', ParseUUIDPipe) agentId: string, @Request() req: any) {
    return { success: true, data: await this.channels.spend(this.org(req), agentId, this.caller(req)) };
  }

  // ─── Visitor data ────────────────────────────────────────────────────
  //
  // Answering one person's request for their data: look them up on the
  // agent's channels, send them their copy, or erase it. Open to anyone
  // who may manage the agent, the rule agent editing uses: an admin or
  // owner of the organization, or a member who owns the agent (the
  // service checks, so a member is refused for an agent not theirs).
  // POST throughout, so what identifies the person stays out of URLs and
  // access logs.

  @Post(':agentId/visitor-data/lookup')
  @HttpCode(200)
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: "What this agent's channels hold about one person, in counts and dates" })
  async lookupVisitorData(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: VisitorDataRequestBodyDto,
    @Request() req: any,
  ) {
    return { success: true, data: await this.requests().lookup(this.org(req), agentId, this.caller(req), body) };
  }

  @Post(':agentId/visitor-data/export')
  @HttpCode(200)
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: "Everything this agent's channels hold about one person, as a JSON file" })
  async exportVisitorData(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: VisitorDataRequestBodyDto,
    @Request() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.requests().export(this.org(req), agentId, this.caller(req), body);
    res.setHeader('Content-Disposition', 'attachment; filename="data-request.json"');
    return data;
  }

  @Post(':agentId/visitor-data/erase')
  @HttpCode(200)
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: "Erase everything this agent's channels hold about one person" })
  async eraseVisitorData(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() body: VisitorDataRequestBodyDto,
    @Request() req: any,
  ) {
    return { success: true, data: await this.requests().erase(this.org(req), agentId, this.caller(req), body) };
  }

  // ─── Channels ────────────────────────────────────────────────────────

  @Get(':agentId/channels')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: "This agent's channels" })
  async list(@Param('agentId', ParseUUIDPipe) agentId: string, @Request() req: any) {
    const channels = await this.channels.list(this.org(req), agentId, this.caller(req));
    return { success: true, data: channels.map(publicChannel) };
  }

  @Post(':agentId/channels')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Add a channel to this agent' })
  async add(@Param('agentId', ParseUUIDPipe) agentId: string, @Body() body: AddChannelBodyDto, @Request() req: any) {
    return {
      success: true,
      data: publicChannel(await this.channels.add(this.org(req), agentId, this.caller(req), body as any)),
    };
  }

  @Get(':agentId/channels/:channelId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'One channel of this agent' })
  async get(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Request() req: any,
  ) {
    return { success: true, data: publicChannel(await this.channels.get(this.org(req), agentId, channelId, this.caller(req))) };
  }

  @Patch(':agentId/channels/:channelId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Change a channel' })
  async update(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() body: UpdateChannelBodyDto,
    @Request() req: any,
  ) {
    return {
      success: true,
      data: publicChannel(await this.channels.update(this.org(req), agentId, channelId, this.caller(req), body as any)),
    };
  }

  @Delete(':agentId/channels/:channelId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Delete a channel' })
  async remove(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Request() req: any,
  ) {
    await this.channels.remove(this.org(req), agentId, channelId, this.caller(req));
    return { success: true };
  }

  @Get(':agentId/channels/:channelId/check')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'What is stopping this channel from going live or being built' })
  async check(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Request() req: any,
  ) {
    return { success: true, data: await this.channels.check(this.org(req), agentId, channelId, this.caller(req)) };
  }

  @Post(':agentId/channels/:channelId/publish')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Make this channel answer' })
  async publish(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Request() req: any,
  ) {
    return {
      success: true,
      data: publicChannel(await this.channels.publish(this.org(req), agentId, channelId, this.caller(req))),
    };
  }

  @Post(':agentId/channels/:channelId/unpublish')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Stop this channel answering, keeping its settings' })
  async unpublish(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Request() req: any,
  ) {
    return {
      success: true,
      data: publicChannel(await this.channels.unpublish(this.org(req), agentId, channelId, this.caller(req))),
    };
  }

  /**
   * Record what a build on the customer's own machine produced (the CLI
   * path, for signing with certificates that never leave their machine).
   */
  @Post(':agentId/channels/:channelId/build-record')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Record the outcome of a local build' })
  async recordBuild(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() body: RecordBuildBodyDto,
    @Request() req: any,
  ) {
    return {
      success: true,
      data: publicChannel(
        await this.channels.recordBuild(this.org(req), agentId, channelId, this.caller(req), {
          version: body.version,
          platform: body.platform,
          checksum: body.checksum,
          signed: body.signed,
          error: body.error,
          builtBy: req.user?.email ?? req.user?.id,
        }),
      ),
    };
  }

  // ─── Builds (desktop and terminal apps) ──────────────────────────────

  @Get(':agentId/channels/:channelId/platforms')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Platforms this channel can be built for' })
  async platforms(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Request() req: any,
  ) {
    const channel = await this.channels.get(this.org(req), agentId, channelId, this.caller(req));
    return {
      success: true,
      data: platformsFor(channel.type).map((platform) => ({ ...platform, signing: signingRequirementFor(platform.id) })),
    };
  }

  @Get(':agentId/channels/:channelId/capabilities')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'What this deployment can build and sign' })
  async capabilities(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Request() req: any,
  ) {
    const channel = await this.channels.get(this.org(req), agentId, channelId, this.caller(req));
    return { success: true, data: await this.builds.capabilities(channel.type) };
  }

  @Post(':agentId/channels/:channelId/builds')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Build a downloadable app' })
  async requestBuild(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() body: RequestBuildBodyDto,
    @Request() req: any,
  ) {
    await this.channels.manageableAgent(this.org(req), agentId, this.caller(req));
    const channel = await this.channels.get(this.org(req), agentId, channelId, this.caller(req));
    return {
      success: true,
      data: publicBuild(
        await this.builds.request(this.org(req), channel, body, req.user?.email ?? req.user?.id ?? null),
      ),
    };
  }

  @Get(':agentId/channels/:channelId/builds')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Build history of this channel' })
  async listBuilds(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Request() req: any,
  ) {
    const agent = await this.channels.readableAgent(this.org(req), agentId, this.caller(req));
    const channel = await this.channels.get(this.org(req), agentId, channelId, this.caller(req));
    const builds = await this.builds.list(this.org(req), channel.id);
    const name = effectiveBranding(agent, channel).appName;
    // What to tell whoever the download is handed to. Computed rather
    // than stored: it depends on how the build turned out and on what
    // the app is called now.
    return {
      success: true,
      data: builds.map((build) => ({
        ...publicBuild(build),
        handoff: handoffFor(
          build.platform,
          build.signed,
          name,
          downloadedFilename(channel.slug ?? 'app', build.version, build.platform, build.artifactKey),
        ),
      })),
    };
  }

  /** A short-lived link to the download, minted per request. */
  @Get(':agentId/channels/:channelId/builds/:buildId/download')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get a download link for a finished build' })
  async download(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Param('buildId', ParseUUIDPipe) buildId: string,
    @Request() req: any,
  ) {
    await this.buildOf(req, agentId, channelId, buildId);
    return { success: true, data: { url: await this.builds.downloadUrl(this.org(req), buildId) } };
  }

  /**
   * The download itself, where the deployment's storage cannot presign.
   * Same ownership and expiry rules as the link.
   */
  @Get(':agentId/channels/:channelId/builds/:buildId/artifact')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Download what a build produced' })
  async artifact(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Param('buildId', ParseUUIDPipe) buildId: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    await this.buildOf(req, agentId, channelId, buildId);
    const { body, filename, bytes } = await this.builds.artifact(this.org(req), buildId);
    // An executable is never rendered inline, and the name is quoted
    // because a slug can contain characters a bare header value ends at.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    if (bytes) res.setHeader('Content-Length', String(bytes));
    body.on('error', () => res.destroy());
    body.pipe(res);
  }

  /** The build, when it is this channel's and the caller may read the agent; 404 otherwise. */
  private async buildOf(req: any, agentId: string, channelId: string, buildId: string) {
    await this.channels.get(this.org(req), agentId, channelId, this.caller(req));
    const build = await this.builds.findOne(this.org(req), buildId);
    if (build.channelId !== channelId) throw new NotFoundException('Build not found');
    return build;
  }
}
