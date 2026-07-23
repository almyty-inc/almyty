import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';

import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { ChannelGatewayService } from './channel-gateway.service';
import { getChannelConfig, normalizeChannelConfigKeys } from './channel-config.helper';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';

/**
 * Discord delivers inbound messages over a persistent Gateway
 * (websocket) connection — there is no inbound webhook for
 * MESSAGE_CREATE the way Slack/Telegram push events over HTTP.
 * This transport maintains one Gateway connection per active
 * discord-type channel gateway and feeds MESSAGE_CREATE dispatches
 * into the same inbound pipeline the webhook-driven channels use
 * (ChannelGatewayService.handleInboundMessage -> DiscordAdapter
 * .normalizeInbound -> agent run -> adapter.sendResponse).
 *
 * Protocol handling (Discord Gateway v10):
 *   - HELLO (op 10)      -> start jittered heartbeats, IDENTIFY or RESUME
 *   - HEARTBEAT_ACK (11) -> mark the connection alive
 *   - HEARTBEAT (op 1)   -> immediate heartbeat on request
 *   - RECONNECT (op 7)   -> close and resume
 *   - INVALID_SESSION (9)-> resume if d === true, else re-identify
 *   - DISPATCH (op 0)    -> READY / RESUMED / MESSAGE_CREATE
 *
 * Reconnects use jittered exponential backoff. A missed heartbeat
 * ACK marks the connection as a zombie and forces a resume cycle.
 * Fatal close codes (bad token, disallowed intents, ...) stop the
 * connection permanently until the gateway config changes.
 *
 * Lifecycle: onApplicationBootstrap starts a connection for every
 * active discord gateway (skipped under NODE_ENV=test). GatewaysService
 * calls sync()/stop() when a discord gateway is created, updated,
 * (de)activated or deleted.
 *
 * Multi-replica safety: every api replica bootstraps the same set of
 * active discord gateways, and Discord happily accepts N concurrent
 * Gateway sessions for one bot — so without coordination each
 * MESSAGE_CREATE would be processed once per replica (duplicate agent
 * runs). A per-gateway distributed lease over the shared ioredis
 * connection elects exactly one replica per gateway:
 *
 *   - acquire: SET <key> <instanceId> NX PX <leaseTtlMs> before
 *     connecting; losers poll every leaseTtlMs/2 to take over.
 *   - renew: every leaseTtlMs/3 while connected — GET to confirm we
 *     still hold it, then PEXPIRE. If another instance took over
 *     (holder mismatch), we tear the socket down and go back to
 *     polling. Transient redis errors keep the socket and just retry
 *     (flapping on every blip would be worse than a briefly unguarded
 *     lease).
 *   - release: compare-and-delete on stop, so a graceful shutdown or
 *     gateway deactivation hands over immediately instead of waiting
 *     for TTL expiry. A crashed holder is covered by the TTL: the
 *     lease expires and a polling replica picks the gateway up.
 *
 * When no redis connection is available (local dev without the redis
 * module), the transport behaves exactly as before: single-instance,
 * connect immediately.
 */

/** Minimal socket surface so tests can substitute a fake. */
export interface DiscordSocket {
  on(event: string, listener: (...args: any[]) => void): void;
  send(data: string): void;
  close(code?: number): void;
  terminate?(): void;
}

/** Minimal redis surface used by the lease (tests substitute a fake). */
export interface DiscordLeaseRedis {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  pexpire(key: string, ttl: number): Promise<number>;
}

export const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

const enum Op {
  DISPATCH = 0,
  HEARTBEAT = 1,
  IDENTIFY = 2,
  RESUME = 6,
  RECONNECT = 7,
  INVALID_SESSION = 9,
  HELLO = 10,
  HEARTBEAT_ACK = 11,
}

/** Close codes after which reconnecting is pointless (config problem). */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Close codes that invalidate the session — reconnect must re-identify. */
const NON_RESUMABLE_CLOSE_CODES = new Set([4007, 4009]);

interface DiscordConnection {
  gateway: Gateway;
  /**
   * Decrypted bot token, resolved once per connect via the org-aware
   * envelope path and cached here. Reading it once (rather than decrypting on
   * every IDENTIFY/RESUME frame) keeps the sync socket handshake independent
   * of the DEK cache TTL for the life of the connection.
   */
  botToken: string | null;
  socket: DiscordSocket | null;
  sessionId: string | null;
  resumeUrl: string | null;
  seq: number | null;
  botUserId: string | null;
  /** Whether the next connect should attempt RESUME instead of IDENTIFY. */
  canResume: boolean;
  heartbeatDelay: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  heartbeatAcked: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  stopped: boolean;
  /** Whether this instance currently holds the distributed lease. */
  leaseHeld: boolean;
  /** Single timer used for both lease renewal and acquisition polling. */
  leaseTimer: NodeJS.Timeout | null;
}

@Injectable()
export class DiscordGatewayTransport implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DiscordGatewayTransport.name);
  private readonly connections = new Map<string, DiscordConnection>();

  /**
   * In-flight lease releases keyed by gateway id. A config update
   * restarts the connection (stop -> start); the release fired by
   * stop() and the acquire fired by start() would otherwise race on
   * the same key — the delayed compare-and-delete could remove the
   * lease the new connection just (re)acquired. tryAcquireLease awaits
   * any pending release for its gateway to serialize the two.
   */
  private readonly pendingReleases = new Map<string, Promise<void>>();

  /** Overridable in tests — production creates a real ws socket. */
  socketFactory: (url: string) => DiscordSocket = (url) =>
    new WebSocket(url) as unknown as DiscordSocket;

  /** Overridable in tests to make backoff deterministic. */
  random: () => number = Math.random;

  /** Distributed-lease TTL. Overridable in tests. */
  leaseTtlMs = 30_000;

  /** Identifies this process as a lease holder. */
  readonly instanceId = randomUUID();

  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    private readonly channelGatewayService: ChannelGatewayService,
    // Optional: without redis (local dev, unit tests) the transport
    // runs in single-instance mode and connects unconditionally.
    @Optional() @InjectRedis() private readonly redis?: DiscordLeaseRedis,
    // Optional so positional unit tests can construct the transport; when
    // present, decrypts a BYO-KMS gateway's kms bot token via the org's CMK.
    @Optional() private readonly envelopeCrypto?: EnvelopeCryptoService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || process.env.DISCORD_GATEWAY_DISABLED === 'true') {
      return;
    }
    try {
      const gateways = await this.gatewayRepository.find({
        where: { type: GatewayType.DISCORD, status: GatewayStatus.ACTIVE },
      });
      for (const gateway of gateways) {
        this.sync(gateway);
      }
      if (gateways.length > 0) {
        this.logger.log(`Starting discord gateway connections for ${gateways.length} gateway(s)`);
      }
    } catch (err: any) {
      this.logger.error(`Failed to bootstrap discord gateway connections: ${err.message}`);
    }
  }

  onModuleDestroy(): void {
    for (const gatewayId of [...this.connections.keys()]) {
      this.stop(gatewayId);
    }
  }

  /**
   * Reconcile the connection for a gateway with its current config:
   * active discord gateway with a bot token -> (re)connect, anything
   * else -> disconnect. Called by GatewaysService on create/update/
   * activate/deactivate.
   */
  sync(gateway: Gateway): void {
    if (gateway.type !== GatewayType.DISCORD) return;
    // Presence check only — inspect the stored (still-encrypted) value
    // rather than decrypting, so this sync entry point never touches the
    // CMK. The token is decrypted later, in connect(), at an async seam.
    const rawToken = normalizeChannelConfigKeys(gateway.configuration).bot_token;
    const shouldRun =
      gateway.status === GatewayStatus.ACTIVE &&
      typeof rawToken === 'string' &&
      rawToken.length > 0;
    if (shouldRun) {
      this.start(gateway);
    } else {
      this.stop(gateway.id);
    }
  }

  /** Open (or replace) the connection for a discord gateway. */
  start(gateway: Gateway): void {
    this.stop(gateway.id);
    const conn: DiscordConnection = {
      gateway,
      botToken: null,
      socket: null,
      sessionId: null,
      resumeUrl: null,
      seq: null,
      botUserId: null,
      canResume: false,
      heartbeatDelay: null,
      heartbeatTimer: null,
      heartbeatAcked: true,
      reconnectTimer: null,
      reconnectAttempts: 0,
      stopped: false,
      leaseHeld: false,
      leaseTimer: null,
    };
    this.connections.set(gateway.id, conn);

    if (!this.redis) {
      // Single-instance mode: no coordination needed (or possible).
      conn.leaseHeld = true;
      this.connect(conn);
      return;
    }
    void this.tryAcquireLease(conn);
  }

  /** Tear down the connection for a gateway (no reconnect). */
  stop(gatewayId: string): void {
    const conn = this.connections.get(gatewayId);
    if (!conn) return;
    conn.stopped = true;
    this.clearTimers(conn);
    try {
      conn.socket?.close(1000);
    } catch {
      /* already closed */
    }
    conn.socket = null;
    this.connections.delete(gatewayId);
    if (conn.leaseHeld) {
      conn.leaseHeld = false;
      this.pendingReleases.set(
        gatewayId,
        this.releaseLease(gatewayId).finally(() => this.pendingReleases.delete(gatewayId)),
      );
    }
  }

  /** Number of live managed connections (observability + tests). */
  get activeConnectionCount(): number {
    return this.connections.size;
  }

  // ---------------------------------------------------------------------------
  // Distributed lease (multi-replica safety)
  // ---------------------------------------------------------------------------

  private leaseKey(gatewayId: string): string {
    return `almyty:discord:gateway-lease:${gatewayId}`;
  }

  /** Try to become the connection holder for a gateway. */
  private async tryAcquireLease(conn: DiscordConnection): Promise<void> {
    if (conn.stopped || !this.redis) return;
    // Serialize with a release from a just-stopped predecessor
    // connection for the same gateway (restart on config update).
    const pendingRelease = this.pendingReleases.get(conn.gateway.id);
    if (pendingRelease) {
      await pendingRelease.catch(() => undefined);
      if (conn.stopped) return;
    }
    try {
      let result = await this.redis.set(
        this.leaseKey(conn.gateway.id),
        this.instanceId,
        'PX',
        this.leaseTtlMs,
        'NX',
      );
      if (conn.stopped) return;
      if (result !== 'OK') {
        // A stale lease of our own (e.g. release failed on a restart)
        // is safe to take over — same process, no duplicate risk.
        const holder = await this.redis.get(this.leaseKey(conn.gateway.id));
        if (conn.stopped) return;
        if (holder === this.instanceId) {
          await this.redis.pexpire(this.leaseKey(conn.gateway.id), this.leaseTtlMs);
          if (conn.stopped) return;
          result = 'OK';
        }
      }
      if (result === 'OK') {
        conn.leaseHeld = true;
        this.logger.log(
          `acquired discord gateway lease (gateway ${conn.gateway.id}, instance ${this.instanceId})`,
        );
        this.connect(conn);
        this.scheduleLeaseRenewal(conn);
        return;
      }
    } catch (err: any) {
      this.logger.warn(
        `discord gateway lease acquire failed (gateway ${conn.gateway.id}): ${err?.message ?? err}`,
      );
    }
    // Another replica holds the lease (or redis hiccuped) — poll so we
    // take over when the holder dies and its lease expires.
    this.scheduleLeaseAcquisition(conn);
  }

  private scheduleLeaseAcquisition(conn: DiscordConnection): void {
    if (conn.stopped || conn.leaseTimer) return;
    conn.leaseTimer = setTimeout(() => {
      conn.leaseTimer = null;
      void this.tryAcquireLease(conn);
    }, Math.max(Math.floor(this.leaseTtlMs / 2), 500));
    conn.leaseTimer.unref?.();
  }

  private scheduleLeaseRenewal(conn: DiscordConnection): void {
    if (conn.stopped || conn.leaseTimer) return;
    conn.leaseTimer = setTimeout(() => {
      conn.leaseTimer = null;
      void this.renewLease(conn);
    }, Math.max(Math.floor(this.leaseTtlMs / 3), 500));
    conn.leaseTimer.unref?.();
  }

  private async renewLease(conn: DiscordConnection): Promise<void> {
    if (conn.stopped || !this.redis || !conn.leaseHeld) return;
    const key = this.leaseKey(conn.gateway.id);
    let holder: string | null;
    try {
      holder = await this.redis.get(key);
      if (conn.stopped) return;
      if (holder === this.instanceId) {
        await this.redis.pexpire(key, this.leaseTtlMs);
        this.scheduleLeaseRenewal(conn);
        return;
      }
    } catch (err: any) {
      // Transient redis failure: keep the socket and retry — tearing
      // down on every blip would flap the bot connection. If redis
      // stays down long enough for the lease to expire, another
      // replica may briefly double-connect; duplicate suppression is
      // restored as soon as renewal succeeds again.
      this.logger.warn(
        `discord gateway lease renew failed (gateway ${conn.gateway.id}): ${err?.message ?? err}`,
      );
      this.scheduleLeaseRenewal(conn);
      return;
    }
    // Lease expired and someone else took it (or it vanished): we are
    // no longer the holder — disconnect and go back to polling.
    this.logger.warn(
      `discord gateway lease lost (gateway ${conn.gateway.id}, holder ${holder ?? 'none'}) — disconnecting`,
    );
    conn.leaseHeld = false;
    this.teardownSocket(conn);
    this.scheduleLeaseAcquisition(conn);
  }

  /** Compare-and-delete so we never delete another instance's lease. */
  private async releaseLease(gatewayId: string): Promise<void> {
    if (!this.redis) return;
    const key = this.leaseKey(gatewayId);
    try {
      const holder = await this.redis.get(key);
      if (holder === this.instanceId) {
        await this.redis.del(key);
      }
    } catch (err: any) {
      // The TTL covers us: an unreleased lease expires on its own.
      this.logger.warn(`discord gateway lease release failed: ${err?.message ?? err}`);
    }
  }

  /** Close the socket without scheduling a reconnect (lease lost). */
  private teardownSocket(conn: DiscordConnection): void {
    this.clearHeartbeatTimers(conn);
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    const socket = conn.socket;
    conn.socket = null;
    if (socket) {
      try {
        socket.close(1000);
      } catch {
        /* already closed */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------

  private connect(conn: DiscordConnection): void {
    if (conn.stopped || !conn.leaseHeld) return;

    // Kick off (non-blocking) a DEK warm for a BYO-KMS gateway so the token
    // is unwrappable by the time Discord's HELLO arrives (a network round
    // trip away). No-op for non-KMS orgs. The socket opens synchronously
    // below regardless, preserving the pre-KMS connect behavior.
    void this.envelopeCrypto?.warmOrg(conn.gateway.organizationId);

    const url =
      conn.canResume && conn.resumeUrl
        ? this.withGatewayParams(conn.resumeUrl)
        : DISCORD_GATEWAY_URL;

    let socket: DiscordSocket;
    try {
      socket = this.socketFactory(url);
    } catch (err: any) {
      this.logger.error(`discord gateway socket creation failed: ${err.message}`);
      this.scheduleReconnect(conn);
      return;
    }

    conn.socket = socket;
    conn.heartbeatAcked = true;

    socket.on('message', (data: any) => {
      try {
        this.handlePayload(conn, socket, JSON.parse(data.toString()));
      } catch (err: any) {
        this.logger.warn(`discord gateway payload parse failed: ${err.message}`);
      }
    });
    socket.on('close', (code: number) => this.handleClose(conn, socket, code));
    socket.on('error', (err: any) => {
      // 'close' always follows 'error' on ws — just log here.
      this.logger.warn(
        `discord gateway socket error (gateway ${conn.gateway.id}): ${err?.message ?? err}`,
      );
    });
  }

  private withGatewayParams(url: string): string {
    return url.includes('?') ? url : `${url}/?v=10&encoding=json`;
  }

  private handlePayload(conn: DiscordConnection, socket: DiscordSocket, payload: any): void {
    if (conn.stopped || conn.socket !== socket) return;
    if (payload.s !== null && payload.s !== undefined) {
      conn.seq = payload.s;
    }

    switch (payload.op) {
      case Op.HELLO:
        this.startHeartbeats(conn, socket, payload.d?.heartbeat_interval ?? 41250);
        // Resolve the bot token now (HELLO precedes the IDENTIFY/RESUME
        // frame). The org's DEK was warmed at connect(), so a BYO-KMS
        // gateway's `encrypted:kms:` token unwraps via this sync read;
        // platform / plaintext tokens are unaffected. Cache on conn so the
        // frames below (and later resumes on the same connection) never
        // re-decrypt. A cold-cache kms read throws -> recycle rather than
        // send a bad/empty token.
        try {
          conn.botToken =
            getChannelConfig(conn.gateway.configuration, conn.gateway.organizationId)
              .bot_token ?? null;
        } catch (err: any) {
          this.logger.error(
            `discord bot token decrypt failed (gateway ${conn.gateway.id}): ${err?.message ?? err}`,
          );
          this.recycle(conn, socket, conn.canResume);
          break;
        }
        if (conn.canResume && conn.sessionId && conn.seq !== null) {
          this.sendResume(conn, socket);
        } else {
          this.sendIdentify(conn, socket);
        }
        break;
      case Op.HEARTBEAT_ACK:
        conn.heartbeatAcked = true;
        break;
      case Op.HEARTBEAT:
        this.sendHeartbeat(conn, socket);
        break;
      case Op.RECONNECT:
        // Discord asks us to reconnect; the session stays resumable.
        this.recycle(conn, socket, true);
        break;
      case Op.INVALID_SESSION:
        this.recycle(conn, socket, payload.d === true);
        break;
      case Op.DISPATCH:
        this.handleDispatch(conn, payload.t, payload.d);
        break;
      default:
        break;
    }
  }

  private handleDispatch(conn: DiscordConnection, type: string, d: any): void {
    switch (type) {
      case 'READY':
        conn.sessionId = d?.session_id ?? null;
        conn.resumeUrl = d?.resume_gateway_url ?? null;
        conn.botUserId = d?.user?.id ?? null;
        conn.canResume = true;
        conn.reconnectAttempts = 0;
        this.logger.log(
          `discord gateway ready (gateway ${conn.gateway.id}, bot ${conn.botUserId ?? '?'})`,
        );
        break;
      case 'RESUMED':
        conn.reconnectAttempts = 0;
        this.logger.log(`discord gateway session resumed (gateway ${conn.gateway.id})`);
        break;
      case 'MESSAGE_CREATE':
        this.handleMessageCreate(conn, d);
        break;
      default:
        break;
    }
  }

  private handleMessageCreate(conn: DiscordConnection, message: any): void {
    if (!message?.author?.id) return;
    // Never react to our own outbound messages (feedback loop).
    if (conn.botUserId && message.author.id === conn.botUserId) return;

    this.channelGatewayService
      .handleInboundMessage(conn.gateway, message, {})
      .catch((err: any) => {
        this.logger.error(
          `discord inbound dispatch failed (gateway ${conn.gateway.id}): ${err.message}`,
        );
      });
  }

  // ---------------------------------------------------------------------------
  // Identify / resume / heartbeat
  // ---------------------------------------------------------------------------

  private sendIdentify(conn: DiscordConnection, socket: DiscordSocket): void {
    this.sendJson(socket, {
      op: Op.IDENTIFY,
      d: {
        token: conn.botToken,
        intents: DISCORD_INTENTS,
        properties: { os: process.platform, browser: 'almyty', device: 'almyty' },
      },
    });
  }

  private sendResume(conn: DiscordConnection, socket: DiscordSocket): void {
    this.sendJson(socket, {
      op: Op.RESUME,
      d: {
        token: conn.botToken,
        session_id: conn.sessionId,
        seq: conn.seq,
      },
    });
  }

  private startHeartbeats(conn: DiscordConnection, socket: DiscordSocket, intervalMs: number): void {
    this.clearHeartbeatTimers(conn);
    conn.heartbeatAcked = true;
    // Discord spec: first heartbeat after heartbeat_interval * jitter.
    conn.heartbeatDelay = setTimeout(() => {
      this.beat(conn, socket);
      conn.heartbeatTimer = setInterval(() => this.beat(conn, socket), intervalMs);
      conn.heartbeatTimer.unref?.();
    }, Math.floor(intervalMs * this.random()));
    conn.heartbeatDelay.unref?.();
  }

  private beat(conn: DiscordConnection, socket: DiscordSocket): void {
    if (conn.stopped || conn.socket !== socket) return;
    if (!conn.heartbeatAcked) {
      // Zombie connection: no ACK since the last heartbeat.
      this.logger.warn(
        `discord gateway missed heartbeat ack (gateway ${conn.gateway.id}) — reconnecting`,
      );
      this.recycle(conn, socket, true);
      return;
    }
    conn.heartbeatAcked = false;
    this.sendHeartbeat(conn, socket);
  }

  private sendHeartbeat(conn: DiscordConnection, socket: DiscordSocket): void {
    this.sendJson(socket, { op: Op.HEARTBEAT, d: conn.seq });
  }

  private sendJson(socket: DiscordSocket, payload: any): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (err: any) {
      this.logger.warn(`discord gateway send failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Close / reconnect
  // ---------------------------------------------------------------------------

  /** Force-close the current socket and reconnect (resume when possible). */
  private recycle(conn: DiscordConnection, socket: DiscordSocket, canResume: boolean): void {
    conn.canResume = canResume && !!conn.sessionId;
    this.clearHeartbeatTimers(conn);
    conn.socket = null;
    try {
      socket.terminate ? socket.terminate() : socket.close(4000);
    } catch {
      /* already closed */
    }
    this.scheduleReconnect(conn);
  }

  private handleClose(conn: DiscordConnection, socket: DiscordSocket, code: number): void {
    // Ignore closes of sockets we already replaced or tore down.
    if (conn.socket !== socket) return;
    this.clearHeartbeatTimers(conn);
    conn.socket = null;
    if (conn.stopped) return;

    if (FATAL_CLOSE_CODES.has(code)) {
      this.logger.error(
        `discord gateway closed with fatal code ${code} (gateway ${conn.gateway.id}) — not reconnecting. Check bot token / intents.`,
      );
      this.connections.delete(conn.gateway.id);
      conn.stopped = true;
      this.clearTimers(conn);
      // Free the lease — every replica would hit the same config error,
      // but a lingering lease would just delay retry after a fix.
      if (conn.leaseHeld) {
        conn.leaseHeld = false;
        void this.releaseLease(conn.gateway.id);
      }
      return;
    }

    if (NON_RESUMABLE_CLOSE_CODES.has(code)) {
      conn.canResume = false;
      conn.sessionId = null;
      conn.seq = null;
    } else {
      conn.canResume = !!conn.sessionId;
    }

    this.scheduleReconnect(conn);
  }

  private scheduleReconnect(conn: DiscordConnection): void {
    if (conn.stopped || conn.reconnectTimer) return;
    const base = Math.min(1000 * 2 ** conn.reconnectAttempts, 60_000);
    const delay = Math.floor(base * (0.5 + this.random() * 0.5)); // jitter: 50-100% of base
    conn.reconnectAttempts += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this.connect(conn);
    }, delay);
    conn.reconnectTimer.unref?.();
  }

  private clearHeartbeatTimers(conn: DiscordConnection): void {
    if (conn.heartbeatDelay) {
      clearTimeout(conn.heartbeatDelay);
      conn.heartbeatDelay = null;
    }
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;
    }
  }

  private clearTimers(conn: DiscordConnection): void {
    this.clearHeartbeatTimers(conn);
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    if (conn.leaseTimer) {
      clearTimeout(conn.leaseTimer);
      conn.leaseTimer = null;
    }
  }
}
