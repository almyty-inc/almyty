import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import { EventEmitter } from 'events';
import { Repository } from 'typeorm';

import { GatewayTool } from '../../entities/gateway-tool.entity';

/** The Redis channel a gateway's tool-set changes are published on. */
export function toolsChangedChannel(gatewayId: string): string {
  return `mcp:changed:${gatewayId}`;
}

const CHANNEL_PATTERN = 'mcp:changed:*';

/**
 * "This gateway's tool set changed", across pods.
 *
 * A modern MCP client holds a `subscriptions/listen` stream on one pod; the
 * change that should reach it (a tool assigned in the dashboard, a tool
 * activated, an MCP source re-synced) happens on whichever pod served that
 * request. Publishers call `gatewayToolsChanged` / `toolsChanged`; every pod
 * hears it on `mcp:changed:<gatewayId>` and hands it to the listen streams it
 * holds for that gateway. The cached tools/list pages of the gateway are
 * dropped first, so the list a notified client fetches is the new one.
 *
 * Redis is optional: without it (tests, single-process dev) delivery is
 * in-process only, which is exactly right for one process.
 */
@Injectable()
export class McpChangeBus implements OnModuleDestroy {
  private readonly logger = new Logger(McpChangeBus.name);
  private readonly local = new EventEmitter();
  private subscriber?: Redis.Redis;
  private subscribing?: Promise<void>;

  constructor(
    @InjectRepository(GatewayTool)
    private readonly gatewayTools: Repository<GatewayTool>,
    @Optional() @InjectRedis() private readonly redis?: Redis.Redis,
  ) {
    this.local.setMaxListeners(0);
  }

  /** A gateway's set of served tools changed. */
  async gatewayToolsChanged(gatewayId: string): Promise<void> {
    if (!gatewayId) return;
    await this.dropToolListCache(gatewayId);
    if (this.redis) {
      try {
        await this.redis.publish(toolsChangedChannel(gatewayId), JSON.stringify({ kind: 'tools', gatewayId }));
        return;
      } catch (err: any) {
        this.logger.warn(`Could not publish a tool change for gateway ${gatewayId}: ${err?.message ?? err}`);
      }
    }
    this.local.emit(gatewayId, 'tools');
  }

  /**
   * Tools changed (activated, deactivated, edited, deleted, re-synced): every
   * gateway that has any of them attached heard about it.
   */
  async toolsChanged(toolIds: string[]): Promise<void> {
    const ids = [...new Set(toolIds.filter(Boolean))];
    if (!ids.length) return;
    let gatewayIds: string[] = [];
    try {
      const rows = await this.gatewayTools
        .createQueryBuilder('gt')
        .select('DISTINCT gt."gatewayId"', 'gatewayId')
        .where('gt."toolId" IN (:...ids)', { ids })
        .getRawMany<{ gatewayId: string }>();
      gatewayIds = rows.map((r) => r.gatewayId);
    } catch (err: any) {
      this.logger.warn(`Could not find the gateways of changed tools: ${err?.message ?? err}`);
      return;
    }
    await Promise.all(gatewayIds.map((id) => this.gatewayToolsChanged(id)));
  }

  /**
   * Hear a gateway's changes. Returns the function that stops listening.
   * The first listener on a pod opens its one subscriber connection.
   */
  onGatewayToolsChanged(gatewayId: string, listener: () => void): () => void {
    this.local.on(gatewayId, listener);
    void this.ensureSubscribed();
    return () => this.local.off(gatewayId, listener);
  }

  /** Listen streams this pod holds, by gateway (diagnostics and tests). */
  listenerCount(gatewayId: string): number {
    return this.local.listenerCount(gatewayId);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      // disconnect, not quit: quit waits forever on a Redis that is gone.
      try { this.subscriber.disconnect(); } catch { /* already gone */ }
      this.subscriber = undefined;
    }
    this.local.removeAllListeners();
  }

  private ensureSubscribed(): Promise<void> {
    if (!this.redis || this.subscribing) return this.subscribing ?? Promise.resolve();
    this.subscribing = (async () => {
      try {
        this.subscriber = this.redis!.duplicate();
        this.subscriber.on('error', (err) => this.logger.warn(`change subscriber: ${err?.message ?? err}`));
        this.subscriber.on('pmessage', (_pattern: string, channel: string) => {
          const gatewayId = channel.slice('mcp:changed:'.length);
          this.local.emit(gatewayId, 'tools');
        });
        await this.subscriber.psubscribe(CHANNEL_PATTERN);
      } catch (err: any) {
        this.logger.error(`Could not subscribe to MCP change notifications: ${err?.message ?? err}`);
        this.subscribing = undefined;
      }
    })();
    return this.subscribing;
  }

  /** Drop the cached tools/list pages of one gateway (McpToolHandler's keys). */
  private async dropToolListCache(gatewayId: string): Promise<void> {
    if (!this.redis) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `mcp:tools:*:${gatewayId}:cursor:*`, 'COUNT', 200);
        if (keys.length) await this.redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
    } catch (err: any) {
      this.logger.warn(`Could not drop the tools/list cache of gateway ${gatewayId}: ${err?.message ?? err}`);
    }
  }
}
