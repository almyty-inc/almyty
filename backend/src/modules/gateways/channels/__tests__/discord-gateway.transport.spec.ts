import {
  DiscordGatewayTransport,
  DiscordSocket,
  DISCORD_GATEWAY_URL,
  DISCORD_INTENTS,
} from '../discord-gateway.transport';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';

/**
 * Unit coverage for the discord Gateway (websocket) transport. The ws
 * layer is fully mocked via the injectable socketFactory: tests drive
 * the protocol by emitting HELLO / READY / MESSAGE_CREATE / close
 * events on fake sockets and assert what the transport sends back
 * (IDENTIFY vs RESUME, heartbeats) and what reaches the inbound
 * channel pipeline. No network, no real timers.
 */

class FakeSocket implements DiscordSocket {
  sent: any[] = [];
  closedWith: number | null = null;
  terminated = false;
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  /** Simulate an inbound gateway payload. */
  receive(payload: any): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }
}

describe('DiscordGatewayTransport', () => {
  let transport: DiscordGatewayTransport;
  let gatewayRepo: { find: jest.Mock };
  let channelService: { handleInboundMessage: jest.Mock };
  let sockets: FakeSocket[];
  let urls: string[];

  const gateway = () =>
    ({
      id: 'gw-discord-1',
      type: GatewayType.DISCORD,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      configuration: { bot_token: 'token-abc' },
    } as unknown as Gateway);

  beforeEach(() => {
    jest.useFakeTimers();
    gatewayRepo = { find: jest.fn().mockResolvedValue([]) };
    channelService = { handleInboundMessage: jest.fn().mockResolvedValue(undefined) };
    transport = new DiscordGatewayTransport(gatewayRepo as any, channelService as any);
    sockets = [];
    urls = [];
    transport.socketFactory = (url: string) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      urls.push(url);
      return socket;
    };
    transport.random = () => 0.5; // deterministic jitter
  });

  afterEach(() => {
    transport.onModuleDestroy();
    jest.useRealTimers();
  });

  const hello = (socket: FakeSocket, interval = 40000) =>
    socket.receive({ op: 10, s: null, d: { heartbeat_interval: interval } });

  const ready = (socket: FakeSocket) =>
    socket.receive({
      op: 0,
      t: 'READY',
      s: 1,
      d: {
        session_id: 'sess-1',
        resume_gateway_url: 'wss://resume.discord.gg',
        user: { id: 'bot-user-1' },
      },
    });

  describe('lifecycle', () => {
    it('does not auto-start connections under NODE_ENV=test', async () => {
      await transport.onApplicationBootstrap();
      expect(gatewayRepo.find).not.toHaveBeenCalled();
      expect(sockets).toHaveLength(0);
    });

    it('start() opens a connection to the discord gateway URL', () => {
      transport.start(gateway());
      expect(urls).toEqual([DISCORD_GATEWAY_URL]);
      expect(transport.activeConnectionCount).toBe(1);
    });

    it('stop() closes the socket and forgets the connection', () => {
      transport.start(gateway());
      transport.stop('gw-discord-1');
      expect(sockets[0].closedWith).toBe(1000);
      expect(transport.activeConnectionCount).toBe(0);
      // A close event on the stopped socket must not trigger a reconnect.
      sockets[0].emit('close', 1000);
      jest.advanceTimersByTime(120_000);
      expect(sockets).toHaveLength(1);
    });

    it('sync() starts active gateways and stops inactive ones', () => {
      const gw = gateway();
      transport.sync(gw);
      expect(transport.activeConnectionCount).toBe(1);

      transport.sync({ ...gw, status: GatewayStatus.INACTIVE } as Gateway);
      expect(transport.activeConnectionCount).toBe(0);
    });

    it('sync() ignores non-discord gateways', () => {
      transport.sync({ ...gateway(), type: GatewayType.SLACK } as Gateway);
      expect(transport.activeConnectionCount).toBe(0);
    });
  });

  describe('identify', () => {
    it('sends a correctly shaped IDENTIFY on HELLO', () => {
      transport.start(gateway());
      hello(sockets[0]);

      const identify = sockets[0].sent[0];
      expect(identify.op).toBe(2);
      expect(identify.d.token).toBe('token-abc');
      expect(identify.d.intents).toBe(DISCORD_INTENTS);
      // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
      expect(identify.d.intents).toBe(1 + 512 + 4096 + 32768);
      expect(identify.d.properties).toEqual(
        expect.objectContaining({ browser: 'almyty', device: 'almyty' }),
      );
    });
  });

  describe('heartbeat', () => {
    it('heartbeats after the jittered delay, then on the fixed interval', () => {
      transport.start(gateway());
      hello(sockets[0], 40000);
      ready(sockets[0]);

      expect(sockets[0].sent.filter((p) => p.op === 1)).toHaveLength(0);

      // First heartbeat at interval * jitter(0.5) = 20s, with last seq.
      jest.advanceTimersByTime(20_000);
      let beats = sockets[0].sent.filter((p) => p.op === 1);
      expect(beats).toHaveLength(1);
      expect(beats[0].d).toBe(1);

      // ACK it, then the next beat comes one full interval later.
      sockets[0].receive({ op: 11, s: null, d: null });
      jest.advanceTimersByTime(40_000);
      beats = sockets[0].sent.filter((p) => p.op === 1);
      expect(beats).toHaveLength(2);
    });

    it('sends an immediate heartbeat when the server requests one (op 1)', () => {
      transport.start(gateway());
      hello(sockets[0]);
      sockets[0].receive({ op: 1, s: null, d: null });
      expect(sockets[0].sent.some((p) => p.op === 1)).toBe(true);
    });

    it('treats a missed heartbeat ACK as a zombie connection and reconnects with RESUME', () => {
      transport.start(gateway());
      hello(sockets[0], 40000);
      ready(sockets[0]);

      jest.advanceTimersByTime(20_000); // first beat, never ACKed
      jest.advanceTimersByTime(40_000); // second tick detects the missed ACK

      expect(sockets[0].terminated).toBe(true);

      // Jittered backoff (attempt 0: 1000 * 0.75), then a resume connect.
      jest.advanceTimersByTime(1_000);
      expect(sockets).toHaveLength(2);
      expect(urls[1]).toContain('wss://resume.discord.gg');

      hello(sockets[1]);
      const resume = sockets[1].sent[0];
      expect(resume.op).toBe(6);
      expect(resume.d).toEqual({ token: 'token-abc', session_id: 'sess-1', seq: 1 });
    });
  });

  describe('MESSAGE_CREATE dispatch', () => {
    it('feeds MESSAGE_CREATE into the channel inbound pipeline', () => {
      const gw = gateway();
      transport.start(gw);
      hello(sockets[0]);
      ready(sockets[0]);

      const message = {
        id: 'msg-1',
        content: 'hello agent',
        author: { id: 'user-9' },
        channel_id: 'chan-5',
        guild_id: 'guild-2',
      };
      sockets[0].receive({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: message });

      expect(channelService.handleInboundMessage).toHaveBeenCalledTimes(1);
      expect(channelService.handleInboundMessage).toHaveBeenCalledWith(gw, message, {});
    });

    it('ignores the bot own messages (no feedback loop)', () => {
      transport.start(gateway());
      hello(sockets[0]);
      ready(sockets[0]);

      sockets[0].receive({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 2,
        d: { id: 'msg-2', content: 'echo', author: { id: 'bot-user-1', bot: true }, channel_id: 'c' },
      });

      expect(channelService.handleInboundMessage).not.toHaveBeenCalled();
    });

    it('ignores payloads without an author', () => {
      transport.start(gateway());
      hello(sockets[0]);
      ready(sockets[0]);
      sockets[0].receive({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { content: 'ghost' } });
      expect(channelService.handleInboundMessage).not.toHaveBeenCalled();
    });
  });

  describe('resume vs re-identify', () => {
    it('resumes after a resumable close (session + seq preserved)', () => {
      transport.start(gateway());
      hello(sockets[0]);
      ready(sockets[0]);

      sockets[0].emit('close', 1006); // abnormal closure — resumable
      jest.advanceTimersByTime(1_000);

      expect(sockets).toHaveLength(2);
      expect(urls[1]).toBe('wss://resume.discord.gg/?v=10&encoding=json');

      hello(sockets[1]);
      expect(sockets[1].sent[0]).toEqual({
        op: 6,
        d: { token: 'token-abc', session_id: 'sess-1', seq: 1 },
      });
    });

    it('re-identifies after a session-invalidating close code (4009)', () => {
      transport.start(gateway());
      hello(sockets[0]);
      ready(sockets[0]);

      sockets[0].emit('close', 4009); // session timed out — cannot resume
      jest.advanceTimersByTime(1_000);

      expect(sockets).toHaveLength(2);
      expect(urls[1]).toBe(DISCORD_GATEWAY_URL);

      hello(sockets[1]);
      expect(sockets[1].sent[0].op).toBe(2); // IDENTIFY, not RESUME
    });

    it('re-identifies when discord flags the session as non-resumable (op 9, d=false)', () => {
      transport.start(gateway());
      hello(sockets[0]);
      ready(sockets[0]);

      sockets[0].receive({ op: 9, s: null, d: false });
      jest.advanceTimersByTime(1_000);

      expect(sockets).toHaveLength(2);
      hello(sockets[1]);
      expect(sockets[1].sent[0].op).toBe(2);
    });

    it('resumes on a RECONNECT request (op 7)', () => {
      transport.start(gateway());
      hello(sockets[0]);
      ready(sockets[0]);

      sockets[0].receive({ op: 7, s: null, d: null });
      jest.advanceTimersByTime(1_000);

      expect(sockets).toHaveLength(2);
      hello(sockets[1]);
      expect(sockets[1].sent[0].op).toBe(6);
    });

    it('gives up permanently on a fatal close code (4004 bad token)', () => {
      transport.start(gateway());
      hello(sockets[0]);

      sockets[0].emit('close', 4004);
      jest.advanceTimersByTime(600_000);

      expect(sockets).toHaveLength(1);
      expect(transport.activeConnectionCount).toBe(0);
    });

    it('backs off exponentially across repeated failures', () => {
      transport.start(gateway());

      // Failure 1: reconnect after 1000 * 0.75.
      sockets[0].emit('close', 1006);
      jest.advanceTimersByTime(749);
      expect(sockets).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);

      // Failure 2: reconnect after 2000 * 0.75.
      sockets[1].emit('close', 1006);
      jest.advanceTimersByTime(1_499);
      expect(sockets).toHaveLength(2);
      jest.advanceTimersByTime(1);
      expect(sockets).toHaveLength(3);
    });
  });
});
