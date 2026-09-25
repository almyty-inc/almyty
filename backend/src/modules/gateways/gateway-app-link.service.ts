import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentApp } from '../../entities/agent-app.entity';
import { AppDistribution, DistributionTarget } from '../../entities/agent-app-distribution.entity';
import type { Gateway } from '../../entities/gateway.entity';
import { hostedChatBlockFor } from './channels/hosted-chat.config';

/** The app a gateway was published from, and which of its places it is. */
export interface GatewayManagedBy {
  app: { id: string; slug: string; name: string };
  target: DistributionTarget;
}

/**
 * Which app owns a gateway.
 *
 * An app is the one place an agent is put in front of people. Publishing
 * one of its places stands up a gateway and records it on the
 * distribution (`gatewayId`), so the owner is found by that column, never
 * by name or endpoint. Everything that asks "is this gateway an app's?"
 * asks here: the gateway page's "Managed in" link, and the hosted chat,
 * which reads its branding from the app on every request.
 *
 * Lives in the gateways module and reads the two tables directly, because
 * the apps module already depends on this one.
 */
@Injectable()
export class GatewayAppLinkService {
  constructor(
    @InjectRepository(AppDistribution)
    private readonly distributions: Repository<AppDistribution>,
  ) {}

  /** The distribution (with its app) that points at this gateway, in this organization. */
  async distributionFor(organizationId: string, gatewayId: string): Promise<(AppDistribution & { app: AgentApp }) | null> {
    if (!organizationId || !gatewayId) return null;
    const found = await this.distributions.findOne({
      where: { organizationId, gatewayId },
      relations: { app: true },
    });
    if (!found?.app || found.app.organizationId !== organizationId) return null;
    return found as AppDistribution & { app: AgentApp };
  }

  /** What the gateway page links to, or null for a gateway no app owns. */
  async managedBy(organizationId: string, gatewayId: string): Promise<GatewayManagedBy | null> {
    const found = await this.distributionFor(organizationId, gatewayId);
    if (!found) return null;
    return {
      app: { id: found.app.id, slug: found.app.slug, name: found.app.branding?.appName || found.app.name },
      target: found.target,
    };
  }

  /**
   * The gateway as the public hosted chat should see it: its own address,
   * the app's branding, sign-in rule and visitor rights. Returns a copy;
   * the stored row is never changed here.
   */
  async withAppSettings(gateway: Gateway): Promise<Gateway> {
    const found = await this.distributionFor(gateway.organizationId, gateway.id);
    const configuration = gateway.configuration ?? {};
    const hostedChat = hostedChatBlockFor(found?.app ?? null, configuration.hostedChat);
    return Object.assign(Object.create(Object.getPrototypeOf(gateway)), gateway, {
      configuration: { ...configuration, hostedChat },
    });
  }
}
