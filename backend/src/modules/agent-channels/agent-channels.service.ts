import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import {
  AgentChannel,
  ChannelBranding,
  ChannelStatus,
  ChannelType,
  VisitorRules,
  isChannelType,
} from '../../entities/agent-channel.entity';
import { Gateway } from '../../entities/gateway.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { assertManageable, assertReadable } from '../../common/authorization/read-rule';
import { GatewaysService } from '../gateways/gateways.service';
import { OrgLicenseResolver } from '../licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';
import { CredentialRefResolver } from '../credentials/credential-ref.resolver';
import { channelSecretKeysIn } from '../gateways/channels/channel-config.helper';
import { ChannelPolicyService, SpendStatus } from '../gateways/channel-policy.service';
import {
  ChannelCheck,
  ChannelContext,
  ChannelRefusalCode,
  SLUGGED_CHANNEL_TYPES,
  buildVersionError,
  channelSlugError,
  channelSlugFromName,
  CHANNEL_REFUSALS,
  carriesDisclosure,
  channelNameError,
  checkChannel,
  defaultBundleId,
  defaultChannelName,
  disclosureOn,
  effectiveBranding,
  effectiveVisitorRules,
  isPackagedType,
  normalizeBranding,
  normalizeVisitorRules,
} from './channel-rules';
import {
  GATEWAY_TYPE_FOR_CHANNEL,
  PUBLISH_REFUSALS,
  checkPublish,
  endpointFor,
  gatewayConfigurationFor,
  gatewayNameFor,
  rateLimitFor,
} from './channel-publish';
import { channelSettingsIn, splitChannelSecrets } from './channel-secrets';

/** Who is asking: the signed-in user. */
export interface Caller {
  id: string;
}

/** What adding a channel takes. */
export interface AddChannelInput {
  type: ChannelType;
  /** What the owner calls it. The type's label, numbered when taken, when left out. */
  name?: string | null;
  /** The web chat's address, or a download's file name. Made from the agent's name when left out. */
  slug?: string | null;
  configuration?: Record<string, any>;
  /** A credential from Credentials to take the platform keys from, instead of typing them. */
  credentialId?: string | null;
  branding?: ChannelBranding | null;
  visitorRules?: VisitorRules | null;
}

/** What changing a channel takes. Every field optional; null on an override clears it. */
export interface UpdateChannelInput {
  name?: string;
  /** A web chat's address. */
  slug?: string;
  configuration?: Record<string, any>;
  credentialId?: string | null;
  branding?: ChannelBranding | null;
  visitorRules?: VisitorRules | null;
}

/** The agent's public settings: what every channel inherits. */
export interface PublicSettingsInput {
  branding?: ChannelBranding | null;
  visitorRules?: VisitorRules | null;
}

/** What the channel page shows: the row, where it answers, and what it resolves to. */
export type ChannelView = AgentChannel & {
  endpoint: string;
  /** Whether this organization may turn the AI disclosure off (the white-label entitlement). */
  disclosureRemovable: boolean;
  effective: {
    branding: ReturnType<typeof effectiveBranding>;
    visitorRules: Omit<ReturnType<typeof effectiveVisitorRules>, 'ownSpend'> & { ownSpend: boolean };
  };
};

/** Ceiling on one list of an agent's channels; the page is not paginated. */
export const MAX_CHANNELS_PER_AGENT = 200;

/**
 * Channels on an agent: adding, configuring, publishing and removing
 * them, and the agent's public settings (branding and visitor rules) they
 * inherit.
 *
 * Everything is scoped to an organization in the query and to what the
 * caller may read of the agent, so a channel of an agent the caller cannot
 * see is "not found" like the agent itself. Writes also need the caller to
 * be able to manage the agent.
 */
@Injectable()
export class AgentChannelsService {
  private readonly logger = new Logger(AgentChannelsService.name);

  constructor(
    @InjectRepository(AgentChannel)
    private readonly channelRepository: Repository<AgentChannel>,
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    private readonly gateways: GatewaysService,
    private readonly accessPolicy: AccessPolicyService,
    @Optional()
    private readonly orgLicense?: OrgLicenseResolver,
    // Where a channel's platform keys are kept. Not @Optional(): Nest must
    // inject it; typed optional only for positional unit specs, and without
    // it a key is refused rather than written to the row.
    private readonly credentialRefs?: CredentialRefResolver,
    // The spend caps and what the agent has spent against them.
    private readonly policy?: ChannelPolicyService,
  ) {}

  // ─── Agents ──────────────────────────────────────────────────────────

  /** The agent, or 404 when it is missing or the caller may not read it. */
  async readableAgent(organizationId: string, agentId: string, caller: Caller): Promise<Agent> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    return assertReadable(this.accessPolicy, caller, agent, 'Agent');
  }

  /** The agent, or 404/403 unless the caller may change it. */
  async manageableAgent(organizationId: string, agentId: string, caller: Caller): Promise<Agent> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    return assertManageable(this.accessPolicy, caller.id, agent, 'Agent', { ownerManages: true });
  }

  /** The agent's public settings, as stored and as they resolve. */
  async publicSettings(organizationId: string, agentId: string, caller: Caller) {
    const agent = await this.readableAgent(organizationId, agentId, caller);
    return this.publicSettingsOf(agent);
  }

  private publicSettingsOf(agent: Agent) {
    return {
      branding: agent.branding ?? null,
      visitorRules: agent.visitorRules ?? null,
      effective: {
        branding: effectiveBranding(agent),
        visitorRules: effectiveVisitorRules(agent),
      },
    };
  }

  /**
   * Change what every channel of the agent inherits. Live channels are
   * re-synced so a new limit applies without republishing.
   */
  async updatePublicSettings(organizationId: string, agentId: string, caller: Caller, input: PublicSettingsInput) {
    const agent = await this.manageableAgent(organizationId, agentId, caller);
    try {
      if (input.branding !== undefined) agent.branding = normalizeBranding(input.branding);
      if (input.visitorRules !== undefined) agent.visitorRules = normalizeVisitorRules(input.visitorRules);
    } catch (err: any) {
      throw new BadRequestException(err?.message ?? 'Those settings are not valid.');
    }
    // Only these two columns: an agent save touches its version history
    // and a whole-row save would race the agent editor.
    await this.agentRepository.update(
      { id: agent.id, organizationId },
      { branding: agent.branding as any, visitorRules: agent.visitorRules as any },
    );
    await this.resyncLiveChannels(organizationId, agent, caller);
    return this.publicSettingsOf(agent);
  }

  /** What the agent's shared allowance, and each channel with its own, has spent. */
  async spend(organizationId: string, agentId: string, caller: Caller): Promise<{
    agent: SpendStatus;
    channels: Array<{ channelId: string; status: SpendStatus }>;
  }> {
    const agent = await this.readableAgent(organizationId, agentId, caller);
    if (!this.policy) throw new ServiceUnavailableException('Spend tracking is not available.');
    const channels = await this.channelRepository.find({ where: { organizationId, agentId } });
    const own = channels.filter((c) => effectiveVisitorRules(agent, c).ownSpend);
    return {
      agent: await this.policy.spendStatus({ kind: 'agent', agent }),
      channels: await Promise.all(
        own.map(async (channel) => ({
          channelId: channel.id,
          status: await this.policy!.spendStatus({ kind: 'channel', channel, agent }),
        })),
      ),
    };
  }

  // ─── Channels ────────────────────────────────────────────────────────

  async list(organizationId: string, agentId: string, caller: Caller): Promise<ChannelView[]> {
    const agent = await this.readableAgent(organizationId, agentId, caller);
    const channels = await this.channelRepository.find({
      where: { organizationId, agentId },
      order: { createdAt: 'ASC' },
      take: MAX_CHANNELS_PER_AGENT,
    });
    return this.views(agent, channels);
  }

  async get(organizationId: string, agentId: string, channelId: string, caller: Caller): Promise<ChannelView> {
    const agent = await this.readableAgent(organizationId, agentId, caller);
    const channel = await this.channelOf(organizationId, agent, channelId);
    return (await this.views(agent, [channel]))[0];
  }

  private async channelOf(organizationId: string, agent: Agent, channelId: string): Promise<AgentChannel> {
    const channel = await this.channelRepository.findOne({ where: { id: channelId, organizationId, agentId: agent.id } });
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  private async views(agent: Agent, channels: AgentChannel[]): Promise<ChannelView[]> {
    const disclosureRemovable = channels.length ? (await this.entitlements(agent.organizationId)).hasWhiteLabel === true : false;
    return channels.map((channel) =>
      Object.assign(channel, {
        endpoint: endpointFor(channel),
        disclosureRemovable,
        effective: {
          branding: effectiveBranding(agent, channel),
          visitorRules: effectiveVisitorRules(agent, channel),
        },
      }),
    );
  }

  async add(organizationId: string, agentId: string, caller: Caller, input: AddChannelInput): Promise<ChannelView> {
    const agent = await this.manageableAgent(organizationId, agentId, caller);
    if (!isChannelType(input.type)) throw new BadRequestException('That is not a kind of channel.');
    // A channel is in front of people; a private ("just me") agent cannot be.
    if (agent.visibility === 'private') throw new BadRequestException(PUBLISH_REFUSALS.AGENT_PRIVATE);

    const slug = SLUGGED_CHANNEL_TYPES.includes(input.type) ? await this.freeSlug(agent, input.type, input.slug) : null;
    const name = await this.freeName(agent, input.type, input.name);
    const overrides = this.normalizedOverrides(input);

    let configuration: Record<string, any> = this.withoutKeys(input.configuration);
    await this.assertDisclosureSwitch(agent, input.type, configuration);
    // A new desktop or terminal app starts with a bundle id made from its
    // address and opens the agent's first web chat, so the first build
    // needs nothing typed in.
    if (isPackagedType(input.type) && !configuration.bundleId) configuration.bundleId = defaultBundleId(slug!);
    if (input.type === ChannelType.DESKTOP && !configuration.webChatChannelId) {
      const webChat = await this.channelRepository.findOne({
        where: { organizationId, agentId, type: ChannelType.WEB },
        order: { createdAt: 'ASC' },
      });
      if (webChat) configuration.webChatChannelId = webChat.id;
    }

    const created = await this.channelRepository.save(
      this.channelRepository.create({
        organizationId,
        agentId,
        type: input.type,
        status: ChannelStatus.DRAFT,
        name,
        slug,
        gatewayId: null,
        configuration,
        ...overrides,
      }),
    );

    if (!input.credentialId) return (await this.views(agent, [created]))[0];
    created.configuration = await this.useCredential(agent, created, input.credentialId, caller);
    const saved = await this.channelRepository.save(created);
    return (await this.views(agent, [saved]))[0];
  }

  async update(
    organizationId: string,
    agentId: string,
    channelId: string,
    caller: Caller,
    input: UpdateChannelInput,
  ): Promise<ChannelView> {
    const agent = await this.manageableAgent(organizationId, agentId, caller);
    const channel = await this.channelOf(organizationId, agent, channelId);
    const overrides = this.normalizedOverrides(input);
    if (input.name !== undefined && input.name.trim() !== channel.name) {
      channel.name = await this.freeName(agent, channel.type, input.name, channel.id);
    }
    if (input.slug !== undefined && input.slug.trim().toLowerCase() !== channel.slug) {
      // Only a web chat's address is the owner's to choose: a download's
      // file name follows its App ID and build.
      if (channel.type !== ChannelType.WEB) throw new BadRequestException('Only a web chat has an address to change.');
      channel.slug = await this.freeSlug(agent, channel.type, input.slug, channel);
    }
    if ('branding' in overrides) channel.branding = overrides.branding ?? null;
    if ('visitorRules' in overrides) channel.visitorRules = overrides.visitorRules ?? null;

    if (input.configuration !== undefined) {
      // Merged rather than replaced, so a caller that sends one field does
      // not drop the others. Clearing a field is done by sending it empty.
      const incoming = this.withoutKeys(input.configuration);
      await this.assertDisclosureSwitch(agent, channel.type, incoming);
      // A key never stays on the row, whatever wrote it there.
      channel.configuration = {
        ...splitChannelSecrets(channel.configuration).publicConfig,
        ...incoming,
        ...this.credentialReference(channel.configuration),
      };
    }
    if (input.credentialId !== undefined) {
      channel.configuration = input.credentialId
        ? await this.useCredential(agent, channel, input.credentialId, caller)
        : this.dropCredential(channel);
    }

    const saved = await this.channelRepository.save(channel);
    if (saved.status === ChannelStatus.LIVE) await this.resync(organizationId, agent, saved, caller);
    return (await this.views(agent, [saved]))[0];
  }

  async remove(organizationId: string, agentId: string, channelId: string, caller: Caller): Promise<void> {
    const agent = await this.manageableAgent(organizationId, agentId, caller);
    const channel = await this.channelOf(organizationId, agent, channelId);
    // The gateway it answered on goes with it: a channel gateway with no
    // channel would keep answering with none of the agent's limits on it.
    if (channel.gatewayId) {
      const gateway = await this.gatewayRepository.findOne({ where: { id: channel.gatewayId, organizationId } });
      if (gateway) await this.gateways.deleteGateway(gateway.id, organizationId, caller.id);
    }
    // The credential it used stays on Credentials: it is the org's, not the channel's.
    await this.channelRepository.remove(channel);
  }

  /** Whether the channel may go live or be built, and if not, why. */
  async check(organizationId: string, agentId: string, channelId: string, caller: Caller): Promise<ChannelCheck> {
    const agent = await this.readableAgent(organizationId, agentId, caller);
    const channel = await this.channelOf(organizationId, agent, channelId);
    return this.checkOf(agent, channel);
  }

  private async checkOf(agent: Agent, channel: AgentChannel): Promise<ChannelCheck> {
    const rules = effectiveVisitorRules(agent, channel);
    const result = checkChannel(
      { type: channel.type, slug: channel.slug, configuration: channel.configuration, branding: effectiveBranding(agent, channel), rules },
      await this.entitlements(agent.organizationId),
    );
    if (channel.type === ChannelType.DESKTOP) {
      const webChats = await this.channelRepository.count({
        where: { organizationId: agent.organizationId, agentId: agent.id, type: ChannelType.WEB },
      });
      if (webChats === 0) {
        result.refusals.push({ code: 'DESKTOP_NEEDS_WEB_CHAT' as ChannelRefusalCode, message: PUBLISH_REFUSALS.DESKTOP_NEEDS_WEB_CHAT });
        result.ok = false;
      }
    }
    return result;
  }

  /**
   * Turning a channel's AI disclosure off is removing it, which only an
   * org with the white-label entitlement may do (EU AI Act Art. 50). It is
   * refused when saved, not only at publish, because the hosted chat and
   * the widget read the switch live.
   */
  private async assertDisclosureSwitch(agent: Agent, type: ChannelType, configuration: Record<string, any>): Promise<void> {
    if (configuration.aiDisclosure === undefined) return;
    if (typeof configuration.aiDisclosure !== 'boolean') throw new BadRequestException('The AI disclosure switch is on or off.');
    if (!carriesDisclosure(type)) {
      delete configuration.aiDisclosure;
      return;
    }
    if (configuration.aiDisclosure === false && !(await this.entitlements(agent.organizationId)).hasWhiteLabel) {
      throw new BadRequestException(CHANNEL_REFUSALS.DISCLOSURE_REMOVAL_NOT_ENTITLED);
    }
  }

  private async entitlements(organizationId: string): Promise<ChannelContext> {
    const has = async (key: string) => {
      try {
        return this.orgLicense ? await this.orgLicense.hasForOrg(organizationId, key) : false;
      } catch {
        return false;
      }
    };
    return { hasEnterpriseAuth: await has('sso'), hasWhiteLabel: await has(EE_ENTITLEMENTS.WHITE_LABEL) };
  }

  /**
   * Make a channel answer: stand up the gateway of its type, wired to the
   * agent, and mark the channel live.
   *
   * Idempotent. Publishing something already published re-syncs the
   * gateway with the agent's current settings rather than creating a
   * second one.
   */
  async publish(organizationId: string, agentId: string, channelId: string, caller: Caller): Promise<ChannelView> {
    const agent = await this.manageableAgent(organizationId, agentId, caller);
    const channel = await this.channelOf(organizationId, agent, channelId);

    // Keys a picked credential holds are read fresh, so a change made on
    // Credentials since it was picked is what goes live.
    await this.refreshFromCredential(channel);
    const product = await this.checkOf(agent, channel);
    const publish = checkPublish(channel.type, agent);
    const refusals = [...product.refusals, ...publish.refusals];
    if (refusals.length) throw new BadRequestException(refusals.map((r) => r.message).join(' '));

    // Stand the gateway up quiet, record it on the channel, and only then
    // let it answer. A crash in between leaves a channel marked live in
    // front of a gateway that is not answering: visible, takes no
    // messages, and republishing (idempotent) fixes it. The other order
    // left a surface answering customers that nothing had a handle on.
    const gateway = await this.upsertGateway(agent, channel, caller, false);
    channel.gatewayId = gateway.id;
    channel.status = ChannelStatus.LIVE;
    const saved = await this.channelRepository.save(channel);
    await this.gateways.activateGateway(gateway.id, organizationId, caller.id);
    return (await this.views(agent, [saved]))[0];
  }

  /**
   * Stop answering, keeping the channel. The gateway is deactivated
   * rather than deleted, so republishing keeps the same address and
   * nothing on the platform side has to be registered again.
   */
  async unpublish(organizationId: string, agentId: string, channelId: string, caller: Caller): Promise<ChannelView> {
    const agent = await this.manageableAgent(organizationId, agentId, caller);
    const channel = await this.channelOf(organizationId, agent, channelId);
    if (channel.gatewayId) await this.gateways.deactivateGateway(channel.gatewayId, organizationId, caller.id);
    channel.status = ChannelStatus.DRAFT;
    const saved = await this.channelRepository.save(channel);
    return (await this.views(agent, [saved]))[0];
  }

  /**
   * Record what a build on the customer's own machine produced, so a
   * question about a download already in the wild has an answer.
   */
  async recordBuild(
    organizationId: string,
    agentId: string,
    channelId: string,
    caller: Caller,
    build: Omit<NonNullable<AgentChannel['lastBuild']>, 'builtAt'>,
  ): Promise<ChannelView> {
    const versionError = buildVersionError(build.version);
    if (versionError) throw new BadRequestException(versionError);
    const agent = await this.manageableAgent(organizationId, agentId, caller);
    const channel = await this.channelOf(organizationId, agent, channelId);
    const { version, platform, checksum, signed, error, builtBy } = build;
    channel.lastBuild = Object.fromEntries(
      Object.entries({ version, platform, checksum, signed, error, builtBy, builtAt: new Date().toISOString() }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    channel.status = build.error ? ChannelStatus.FAILED : ChannelStatus.BUILT;
    const saved = await this.channelRepository.save(channel);
    return (await this.views(agent, [saved]))[0];
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private normalizedOverrides(input: { branding?: unknown; visitorRules?: unknown }): {
    branding?: ChannelBranding | null;
    visitorRules?: VisitorRules | null;
  } {
    try {
      return {
        ...(input.branding !== undefined ? { branding: normalizeBranding(input.branding) } : {}),
        ...(input.visitorRules !== undefined ? { visitorRules: normalizeVisitorRules(input.visitorRules) } : {}),
      };
    } catch (err: any) {
      throw new BadRequestException(err?.message ?? 'Those settings are not valid.');
    }
  }

  /**
   * A free address for a new web chat or download. A web chat's is a
   * subdomain, so it must be free across every organization; a download's
   * is only a file name.
   */
  private async freeSlug(
    agent: Agent,
    type: ChannelType,
    wanted?: string | null,
    /** The web chat being renamed: its own address and gateway do not count as taken. */
    self?: Pick<AgentChannel, 'id' | 'gatewayId'>,
  ): Promise<string> {
    const taken = async (slug: string) => {
      if (type !== ChannelType.WEB) return false;
      const channel = await this.channelRepository.count({
        where: { type: ChannelType.WEB, slug, ...(self ? { id: Not(self.id) } : {}) },
      });
      if (channel > 0) return true;
      const gateways = this.gatewayRepository
        .createQueryBuilder('gateway')
        .where("gateway.configuration::jsonb -> 'hostedChat' ->> 'slug' = :slug", { slug });
      if (self?.gatewayId) gateways.andWhere('gateway.id != :own', { own: self.gatewayId });
      return (await gateways.getCount()) > 0;
    };
    if (wanted !== undefined && wanted !== null && wanted !== '') {
      const slug = wanted.trim().toLowerCase();
      const error = channelSlugError(slug);
      if (error) throw new BadRequestException(error);
      // The address is a subdomain every organization shares, so it has to
      // be free everywhere, not only in this organization.
      if (await taken(slug)) {
        throw new ConflictException(`${slug} is already taken as a web chat address. Pick another.`);
      }
      return slug;
    }
    const used = new Set<string>();
    // Candidates are checked one at a time; the first free one wins.
    let candidate = channelSlugFromName(agent.name, (s) => used.has(s));
    while (await taken(candidate)) {
      used.add(candidate);
      candidate = channelSlugFromName(agent.name, (s) => used.has(s));
    }
    return candidate;
  }

  /**
   * A name none of the agent's other channels has. Asked for: used as it
   * is, or refused when another channel has it. Not asked for: the type's
   * label, numbered when taken.
   */
  private async freeName(agent: Agent, type: ChannelType, wanted?: string | null, selfId?: string): Promise<string> {
    const siblings = await this.channelRepository.find({
      where: { organizationId: agent.organizationId, agentId: agent.id },
      select: { id: true, name: true },
    });
    const names = new Set(siblings.filter((c) => c.id !== selfId).map((c) => (c.name ?? '').toLowerCase()));
    if (wanted === undefined || wanted === null || (wanted === '' && !selfId)) {
      return defaultChannelName(type, (name) => names.has(name.toLowerCase()));
    }
    const error = channelNameError(wanted);
    if (error) throw new BadRequestException(error);
    const name = wanted.trim();
    if (names.has(name.toLowerCase())) {
      throw new ConflictException(`${agent.name} already has a channel called ${name}. Pick another name.`);
    }
    return name;
  }

  /** `credentialId` / `credentialKeys` of a stored configuration, the only server-owned keys it keeps. */
  private credentialReference(configuration: Record<string, any> | null | undefined): Record<string, any> {
    const id = configuration?.credentialId;
    if (typeof id !== 'string' || !id) return {};
    return { credentialId: id, credentialKeys: Array.isArray(configuration?.credentialKeys) ? configuration!.credentialKeys : [] };
  }

  /**
   * Platform settings, with no key in them. Keys are a credential on
   * Credentials, picked by `credentialId`; one sent inline is refused
   * rather than stored on the row.
   */
  private withoutKeys(configuration: Record<string, any> | null | undefined): Record<string, any> {
    const { secrets, cleared, publicConfig } = splitChannelSecrets(configuration ?? {});
    const keys = [...Object.keys(secrets), ...cleared];
    if (keys.length > 0) {
      throw new BadRequestException(
        `Platform keys (${keys.join(', ')}) go in a credential on Credentials. Pick it with credentialId.`,
      );
    }
    return publicConfig;
  }

  /**
   * Take the platform keys from a credential on Credentials. It must be
   * this organization's and usable by whoever this channel's gateway runs
   * as.
   */
  private async useCredential(
    agent: Agent,
    channel: AgentChannel,
    credentialId: string,
    caller: Caller,
  ): Promise<Record<string, any>> {
    if (!this.credentialRefs) throw new ServiceUnavailableException('The credential store is not available.');
    const credential = await this.credentialRefs.load(channel.organizationId, credentialId).catch(() => null);
    if (!credential) throw new BadRequestException('That credential does not exist.');
    await this.credentialRefs.assertAttachable(
      credential,
      {
        organizationId: channel.organizationId,
        // The channel's gateway runs in its agent's scope.
        visibility: agent.visibility === 'team' ? 'team' : 'org',
        teamId: agent.teamId ?? null,
        noun: 'channel',
      },
      { actorId: caller.id },
    );
    return {
      ...(channel.configuration ?? {}),
      ...channelSettingsIn(credential.config),
      credentialId: credential.id,
      credentialKeys: channelSecretKeysIn(credential.config),
    };
  }

  /**
   * Read a picked credential again: its secret key names, and the plain
   * settings (a phone number, a receiving address) copied onto the channel,
   * which routing and the publish check read from the row.
   */
  private async refreshFromCredential(channel: AgentChannel): Promise<void> {
    const id = channel.configuration?.credentialId;
    if (typeof id !== 'string' || !id || !this.credentialRefs) return;
    const credential = await this.credentialRefs.load(channel.organizationId, id).catch(() => null);
    if (!credential) return;
    channel.configuration = {
      ...(channel.configuration ?? {}),
      ...channelSettingsIn(credential.config),
      credentialKeys: channelSecretKeysIn(credential.config),
    };
  }

  /** Stop using a credential: the reference goes; the credential stays on Credentials. */
  private dropCredential(channel: AgentChannel): Record<string, any> {
    const { credentialId: _id, credentialKeys: _keys, ...rest } = channel.configuration ?? {};
    return rest;
  }

  /** Create or re-sync the gateway a channel answers on. */
  private async upsertGateway(agent: Agent, channel: AgentChannel, caller: Caller, activate: boolean): Promise<Gateway> {
    const rules = effectiveVisitorRules(agent, channel);
    // The switch turns the disclosure off only where the org may remove it;
    // publishing refuses otherwise, and this holds on a re-sync too.
    const off = !disclosureOn(channel.configuration) && (await this.entitlements(agent.organizationId)).hasWhiteLabel;
    const disclosure = off ? false : (effectiveBranding(agent, channel).aiDisclosure ?? '');
    return this.gateways.upsertForChannel(
      {
        name: gatewayNameFor(agent.name, channel.name),
        description: agent.description ?? undefined,
        type: GATEWAY_TYPE_FOR_CHANNEL[channel.type]!,
        agentId: agent.id,
        endpoint: endpointFor(channel),
        // The platform keys (by reference) and, for the web chat, the
        // address block it is looked up by. Branding is read live.
        configuration: gatewayConfigurationFor(channel, rules.authMode, disclosure),
        rateLimitConfig: rateLimitFor(rules.limits, channel.type),
        // A channel serves only what its own scope covers, so a team agent
        // is published through a gateway scoped to that team.
        ...(agent.visibility === 'team' && agent.teamId
          ? { visibility: 'team' as const, teamId: agent.teamId }
          : { visibility: 'org' as const }),
      } as any,
      agent.organizationId,
      caller.id,
      { channelId: channel.id, activate, gatewayId: channel.gatewayId },
    );
  }

  /**
   * Bring a live channel's gateway in line with its settings: sign-in rule,
   * rate limits, keys. Only when the channel still passes its checks; one
   * that no longer does keeps answering as it was, and its page says why.
   */
  private async resync(organizationId: string, agent: Agent, channel: AgentChannel, caller: Caller): Promise<void> {
    if (!channel.gatewayId || channel.status !== ChannelStatus.LIVE) return;
    const check = await this.checkOf(agent, channel);
    if (!check.ok || !checkPublish(channel.type, agent).ok) return;
    try {
      await this.upsertGateway(agent, channel, caller, true);
    } catch (err: any) {
      this.logger.warn(`Could not re-sync channel ${channel.id}: ${err?.message ?? err}`);
    }
  }

  private async resyncLiveChannels(organizationId: string, agent: Agent, caller: Caller): Promise<void> {
    const live = await this.channelRepository.find({
      where: { organizationId, agentId: agent.id, status: ChannelStatus.LIVE, gatewayId: Not(IsNull()) },
    });
    for (const channel of live) await this.resync(organizationId, agent, channel, caller);
  }
}
