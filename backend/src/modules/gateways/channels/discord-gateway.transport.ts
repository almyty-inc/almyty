import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebSocket } from 'ws';

import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { ChannelGatewayService } from './channel-gateway.service';

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
 */

/** Minimal socket surface so tests can substitute a fake. */
export interface DiscordSocket {
  on(event: string, listener: (...args: any[]) => void): void;
  send(data: string): void;
  close(code?: number): void;
  terminate?(): void;
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
}

@Injectable()
export class DiscordGatewayTransport implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DiscordGatewayTransport.name);
  private readonly connections = new Map<string, DiscordConnection>();

  /** Overridable in tests — production creates a real ws socket. */
  socketFactory: (url: string) => DiscordSocket = (url) =>
    new WebSocket(url) as unknown as DiscordSocket;

  /** Overridable in tests to make backoff deterministic. */
  random: () => number = Math.random;

  constructor(
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    private readonly channelGatewayService: ChannelGatewayService,
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
    const shouldRun =
      gateway.status === GatewayStatus.ACTIVE && !!gateway.configuration?.bot_token;
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
    };
    this.connections.set(gateway.id, conn);
    this.connect(conn);
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
  }

  /** Number of live managed connections (observability + tests). */
  get activeConnectionCount(): number {
    return this.connections.size;
  }

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------

  private connect(conn: DiscordConnection): void {
    if (conn.stopped) return;

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
        token: conn.gateway.configuration?.bot_token,
        intents: DISCORD_INTENTS,
        properties: { os: process.platform, browser: 'almyty', device: 'almyty' },
      },
    });
  }

  private sendResume(conn: DiscordConnection, socket: DiscordSocket): void {
    this.sendJson(socket, {
      op: Op.RESUME,
      d: {
        token: conn.gateway.configuration?.bot_token,
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
  }
}
