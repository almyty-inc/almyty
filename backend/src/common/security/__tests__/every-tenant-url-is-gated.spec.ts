import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..');
const EE = join(__dirname, '..', '..', '..', '..', 'ee');

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const read = (file: string) => stripComments(readFileSync(file, 'utf8'));

/**
 * Every outbound request whose URL a tenant can write goes through a gate.
 *
 * The gates exist and are good: `validateUrl` for the string,
 * `decideEgress` for the per-org private-host allowlist, the DNS-pinning
 * agents for the name, `maxRedirects: 0` / `redirect: 'error'` for the
 * 3xx. The defect was never a missing gate — it was call sites that did
 * not call one. Six channel adapters, three test-connection probes, the
 * MCP `import_schema` tool, the A2A `baseRpcUrl`, two model-deployment
 * adapters and the endpoint-provider helper each dialled a tenant-written
 * URL with no check at all, several of them returning the response body
 * or the errno to the caller.
 *
 * So this is a source-reading guard rather than a behavioural one. A
 * behavioural test passes against an ungated call site the moment
 * somebody writes a new one; reading the file is what catches that.
 *
 * Each entry names the file, what tenant-written field feeds it, and the
 * token that proves the gate is present.
 */
describe('tenant-supplied outbound URLs are gated at every call site', () => {
  /** [file, what the tenant writes, a pattern that proves the gate] */
  const GATED: Array<[string, string, RegExp]> = [
    // Channel adapters — gateway.configuration
    ['modules/gateways/channels/adapters/webhook.adapter.ts', 'callback_url / webhook_url', /assertEgress\(/],
    ['modules/gateways/channels/adapters/matrix.adapter.ts', 'homeserver_url', /assertEgress\(/],
    ['modules/gateways/channels/adapters/signal.adapter.ts', 'api_url', /assertEgress\(/],
    ['modules/gateways/channels/adapters/google-chat.adapter.ts', 'webhook_url', /assertEgress\(/],
    ['modules/gateways/channels/adapters/irc.adapter.ts', 'webhook_url', /assertEgress\(/],
    ['modules/gateways/channels/adapters/microsoft-teams.adapter.ts', 'service_url', /assertEgress\(/],
    // test-connection probes on the same configuration
    ['modules/gateways/channels/channel-gateway.service.ts', 'webhook_url / api_url / homeserver_url', /safeFetch\(/],
    // Schema import. Both doors -- the REST route and the MCP
    // import_schema tool -- now come through this one helper, so the gate
    // is asserted where the transport is. #696 gated the MCP copy inline
    // and left this helper (the older, REST door) unpinned; #697 collapsed
    // them, which is why the row moved.
    ['modules/apis/apis-import.helper.ts', 'importSchema url + MCP import_schema schemaUrl', /assertOutboundUrlAllowed\(/],
    // A2A
    ['modules/a2a/a2a-client.service.ts', 'externalAgent.baseRpcUrl', /assertOutboundUrlAllowed\(/],
    // Model deployments — providerConfig
    ['modules/model-deployments/adapters/ollama.adapter.ts', 'providerConfig.baseUrl', /validateUrl(AllowingPrivate)?\(/],
    ['modules/model-deployments/adapters/custom-endpoint.adapter.ts', 'providerConfig.url', /validateUrl(AllowingPrivate)?\(/],
    // The second door onto llm_providers.configuration.apiUrl: the reconcile
    // loop writes a deployment's endpoint URL into a provider row through it
    ['modules/llm-providers/endpoint-provider.helper.ts', 'deployment endpoint url', /decideEgress\(/],
    // The one consumer of that column that did not re-gate at request time
    ['modules/provider-usage/provider-usage.service.ts', 'provider apiUrl', /safeFetch\(/],
  ];

  it.each(GATED)('%s (%s) is gated', (file, _field, gate) => {
    expect(read(join(SRC, file))).toMatch(gate);
  });

  /**
   * The gate is only half of it: an allowed public host that answers 302
   * with an internal Location puts the request back where it started, so
   * every one of these also has to refuse the redirect.
   */
  const REFUSES_REDIRECTS: Array<[string, RegExp]> = [
    ['modules/gateways/channels/adapters/webhook.adapter.ts', /egressInit/],
    ['modules/gateways/channels/adapters/matrix.adapter.ts', /egressInit/],
    ['modules/gateways/channels/adapters/signal.adapter.ts', /egressInit/],
    ['modules/gateways/channels/adapters/google-chat.adapter.ts', /egressInit/],
    ['modules/gateways/channels/adapters/irc.adapter.ts', /egressInit/],
    ['modules/gateways/channels/adapters/microsoft-teams.adapter.ts', /egressInit/],
    ['modules/a2a/a2a-client.service.ts', /maxRedirects: 0/],
    // Follows a few hops, each re-validated (pinned-redirects.ts): a spec URL
    // that 301s to https is the ordinary case, a 302 to 169.254.169.254 is not.
    ['modules/apis/apis-import.helper.ts', /pinnedRedirects\(\)/],
    ['modules/tools/executors/tool-grpc.executor.ts', /maxRedirects: 0/],
    ['modules/model-deployments/adapters/ollama.adapter.ts', /maxRedirects: 0/],
    ['modules/model-deployments/adapters/custom-endpoint.adapter.ts', /maxRedirects: 0/],
  ];

  it.each(REFUSES_REDIRECTS)('%s refuses redirects', (file, pattern) => {
    expect(read(join(SRC, file))).toMatch(pattern);
  });

  /**
   * `tool-grpc` was the odd one out among the executors: its two siblings
   * pin DNS and refuse redirects on the same tenant-written `api.baseUrl`,
   * and it did neither.
   */
  it.each([
    'modules/tools/executors/tool-http.executor.ts',
    'modules/tools/executors/tool-protocol.executor.ts',
    'modules/tools/executors/tool-grpc.executor.ts',
  ])('%s pins DNS', (file) => {
    expect(read(join(SRC, file))).toMatch(/ssrfSafeHttpsAgent/);
  });

  it('the shared adapter fetch init pins DNS and refuses redirects', () => {
    // The six entries above go through egressInit; this is what it does.
    const base = read(join(SRC, 'modules/gateways/channels/adapters/base.adapter.ts'));
    expect(base).toMatch(/redirect: 'error'/);
    expect(base).toMatch(/dispatcher: ssrfSafeDispatcher/);
  });

  it('the audit stream refuses a redirect at delivery time', () => {
    // decideEgress runs when the SIEM target is saved, which judges the
    // host. It says nothing about where that host points later, and the
    // request carries the stream's bearer token.
    expect(read(join(EE, 'modules/audit-export/audit-stream.service.ts'))).toMatch(
      /redirect: 'error'/,
    );
  });

  /**
   * The schema fetch has one door.
   *
   * Two audits found the MCP `import_schema` bypass independently, and the
   * two fixes disagreed: one gated the MCP copy inline, the other routed
   * it into the helper the REST route already used. Inline left the two
   * doors enforcing different rules -- the MCP one pinned DNS and the
   * older REST one did not -- which is the same shape as the original bug
   * one level up. So: one helper, and the tool must not dial for itself.
   */
  it('the schema helper pins DNS, not just the string', () => {
    // pinnedRedirects() carries the pinned agents and swaps in the one
    // matching each hop's protocol; its own spec proves both.
    const helper = read(join(SRC, 'modules/apis/apis-import.helper.ts'));
    expect(helper).toMatch(/\.\.\.pinnedRedirects\(\)/);
  });

  it('the MCP import_schema tool delegates instead of opening its own connection', () => {
    const mcp = read(join(SRC, 'modules/mcp/almyty-mcp.service.ts'));
    expect(mcp).toMatch(/fetchSchemaFromUrl\(String\(args\.schemaUrl\)\)/);
    // The bypass itself, and the inline copy that replaced it: neither
    // belongs in this file now.
    expect(mcp).not.toMatch(/axios\.get\(/);
  });

  it('names files that exist, so this guard cannot pass by reading nothing', () => {
    for (const [file] of GATED) {
      expect(readFileSync(join(SRC, file), 'utf8').length).toBeGreaterThan(0);
    }
    expect(GATED.length).toBeGreaterThanOrEqual(13);
  });
});
