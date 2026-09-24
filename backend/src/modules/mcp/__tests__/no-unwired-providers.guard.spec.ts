import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, join, relative } from 'path';

/**
 * Nothing in the MCP and memory modules may be built and then reached by
 * nobody.
 *
 * Three such units sat here, each compiled and covered by its own spec:
 *  - `WebSocketTransport` with a `handleWebSocketConnection` that no route
 *    or WebSocket server ever called, advertised by `/mcp/ws/info` and in
 *    the transport stats as a transport the platform serves;
 *  - `RealtimeExecutorService`, registered as a provider and injected by
 *    nothing, whose only output was a broadcast over that transport;
 *  - `MemoryCapabilityPublisher`, which minted memory tools that nothing
 *    ever asked it to mint;
 * and `McpOAuthService` carried two metadata builders with no caller whose
 * paths (`/{orgId}/{gatewayId}/oauth/...`) matched no served route.
 *
 * A provider counts as reached when some other production file names it
 * outside a `*.module.ts` registration. Self-driven classes -- queue
 * processors, lifecycle hooks, scheduled jobs -- do their work without a
 * consumer and are exempt.
 */
const SRC = join(__dirname, '..', '..', '..');
const SCANNED = [join('modules', 'mcp'), join('modules', 'memory')];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'migrations') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((full) => ({ rel: relative(SRC, full), src: readFileSync(full, 'utf8') }));
const SELF_DRIVEN = /@Processor\(|implements[^{]*\b(OnModuleInit|OnApplicationBootstrap)\b|@(Cron|Interval|Timeout)\(|@Controller\(/;

describe('MCP and memory providers are reached by something', () => {
  const providers = files
    .filter((f) => SCANNED.some((dir) => f.rel.startsWith(dir)))
    .flatMap((f) =>
      [...f.src.matchAll(/@Injectable\([^)]*\)\s*export class (\w+)/g)].map((m) => ({ name: m[1], file: f })),
    );

  it('finds the providers it is meant to check (it has not gone blind)', () => {
    expect(providers.map((p) => p.name)).toEqual(expect.arrayContaining(['McpOAuthService', 'CanonicalMemoryService']));
  });

  it('every provider is used outside its own file and module registration', () => {
    const unreached = providers
      .filter(({ file }) => !SELF_DRIVEN.test(file.src))
      .filter(({ name, file }) => {
        const word = new RegExp(`\\b${name}\\b`);
        return !files.some(
          (other) => other.rel !== file.rel && !basename(other.rel).endsWith('.module.ts') && word.test(other.src),
        );
      })
      .map(({ name, file }) => `${name} (${file.rel})`);
    expect(unreached).toEqual([]);
  });

  it('serves no WebSocket transport it has no server for', () => {
    const hasServer = files.some((f) => /@WebSocketGateway\(|handleUpgrade\(|new\s+WebSocketServer\(/.test(f.src));
    const transportController = files.find((f) => f.rel.endsWith(join('mcp', 'controllers', 'mcp-transport.controller.ts')))!;
    expect(transportController).toBeDefined();
    if (!hasServer) {
      expect(transportController.src).not.toMatch(/websocket/i);
    }
  });

  it('McpOAuthService builds no discovery document of its own', () => {
    const service = files.find((f) => f.rel.endsWith(join('mcp', 'services', 'mcp-oauth.service.ts')))!;
    expect(service.src).not.toMatch(/getAuthorizationServerMetadata|getProtectedResourceMetadata/);
  });
});
