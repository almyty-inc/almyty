import { readFileSync, readdirSync, statSync } from 'fs';
import { join, sep } from 'path';

/**
 * Every module that opens an outbound connection is on this list, with the
 * reason its URL is safe to dial.
 *
 * The two guards next to this one read the files that already call the
 * egress gate (validator-callers-are-pinned) or that a past audit named
 * (every-tenant-url-is-gated). Neither sees the next module that dials a
 * user-influenced URL without touching the gate at all -- the shape of
 * every SSRF this codebase has had: the OIDC issuer an org admin types,
 * the Nebius control-plane host in providerConfig, a Google region spliced
 * into a hostname, a raw `http.get` of a branding icon. So this one starts
 * from the transports instead: any production file that calls axios,
 * fetch, http(s).get/request, a raw socket, a WebSocket, an S3 client or
 * openid-client must be listed here, and
 *
 *   - `gated`: the URL is user-influenced and the file goes through the
 *     shared guard in common/security (safeFetch / egressAxiosConfig /
 *     assertOutboundUrlAllowed + pinned transport / egressInit /
 *     callLlmProviderHttp / decideEgress). The file must reference one of
 *     them, and validator-callers-are-pinned checks each call's transport.
 *   - `vendor`: the origin is a constant vendor host (or one the vendor's
 *     own API returned); nothing a user writes picks the host. A value that
 *     is spliced INTO a vendor host (a region) must be checked, and the row
 *     says where.
 *   - `codegen`: the call is text in generated source, not a request the
 *     server makes.
 *   - `operator`: the URL comes from the operator's own environment, not
 *     from any tenant or visitor.
 *
 * A new file fails here until someone decides which it is. That decision
 * is the point.
 */
const SRC = join(__dirname, '..', '..', '..');
const EE = join(SRC, '..', 'ee');

type Kind = 'gated' | 'vendor' | 'codegen' | 'operator' | 'gate';

const INVENTORY: Record<string, [Kind, string]> = {
  // The guard itself.
  'src/common/security/safe-fetch.ts': ['gate', 'the guarded client'],
  'src/common/security/egress-proxy.ts': ['gate', 'loopback proxy that vets every target a child process dials'],

  // User-, tenant- or visitor-influenced URLs, through the shared guard.
  'src/modules/apis/apis-import.helper.ts': ['gated', 'schema URL + GraphQL introspection (POST /apis/import, import_schema): egressAxiosConfig, redirects re-gated per hop'],
  'src/modules/apis/apis.service.ts': ['gated', 'API test-connection on api.baseUrl: egressAxiosConfig'],
  'src/modules/apis/credential.service.ts': ['gated', 'credential test + OAuth refresh tokenEndpoint: egressAxiosConfig'],
  'src/modules/a2a/a2a-client.service.ts': ['gated', 'external agent baseRpcUrl: egressAxiosConfig'],
  'src/modules/a2a/external-agents.service.ts': ['gated', 'agent card URL: validateUrl + pinned agents + maxRedirects 0 + cap'],
  'src/modules/agents/agent-webhook.service.ts': ['gated', 'agent webhook URL: validateUrl + pinned agents + maxRedirects 0 + cap'],
  'src/modules/credentials/oauth2.service.ts': ['gated', 'OAuth token endpoint: validateUrl + ssrfSafeDispatcher + redirect manual + capped read'],
  'src/modules/connections/connection-validation.service.ts': ['gated', 'connector probes: guardUrl + ssrfSafeDispatcher (host-scoped exemption under a hatch)'],
  'src/modules/connections/mcp-oauth/mcp-oauth-client.service.ts': ['gated', 'MCP sign-in discovery, registration, token and revocation: validateUrl(AllowingPrivate under MCP_ALLOW_PRIVATE_URLS) + ssrfSafeDispatcher (host-scoped exemption under the hatch) + redirect manual + capped read'],
  'src/modules/mcp-sources/mcp-client.service.ts': ['gated', 'MCP source URL: validateUrl + ssrfSafeDispatcher + redirect error + capResponse'],
  'src/modules/memory/embedding.service.ts': ['gated', 'embedding provider URL: validateUrl + pinned agents'],
  'src/modules/model-registry/model-registry.service.ts': ['gated', 'S3-compatible registry endpoint: validateUrl + pinned NodeHttpHandler'],
  'src/modules/model-deployments/adapters/ollama.adapter.ts': ['gated', 'providerConfig.baseUrl: validateUrl(AllowingPrivate under OLLAMA_ALLOW_PRIVATE_URLS) + pinned'],
  'src/modules/model-deployments/adapters/custom-endpoint.adapter.ts': ['gated', 'providerConfig.url: validateUrl + pinned'],
  'src/modules/llm-providers/providers/safe-request.ts': ['gated', 'every LLM provider call incl. model listing and custom base URLs: gatedConfig'],
  'src/modules/tools/executors/tool-http.executor.ts': ['gated', 'HTTP tools on api.baseUrl: decideToolEgress (validateUrl + org allowlist) + pinned + maxRedirects 0 + cap'],
  'src/modules/tools/executors/tool-http-pagination.ts': ['gated', 'next-page URLs re-validated, inherits the executor config'],
  'src/modules/tools/executors/tool-protocol.executor.ts': ['gated', 'SOAP/GraphQL tools: decideToolEgress (validateUrl + org allowlist) + pinned + maxRedirects 0'],
  // tool-grpc.executor.ts dials through GrpcCallerService with pinDns (no
  // axios any more); every-tenant-url-is-gated.spec.ts pins that.
  'src/modules/gateways/channels/channel-gateway.service.ts': ['gated', 'channel test-connection: safeFetch for configured URLs, vendor constants otherwise'],
  'src/modules/gateways/channels/adapters/webhook.adapter.ts': ['gated', 'outbound webhook_url / callback_url: assertEgress + egressInit + capped read'],
  'src/modules/gateways/channels/adapters/matrix.adapter.ts': ['gated', 'homeserver_url: assertEgress + egressInit'],
  'src/modules/gateways/channels/adapters/signal.adapter.ts': ['gated', 'signal-cli api_url: assertEgress + egressInit'],
  'src/modules/gateways/channels/adapters/imessage-sendblue.adapter.ts': ['gated', 'api.sendblue.co send-message: assertEgress + egressInit'],
  'src/modules/gateways/channels/adapters/imessage-loopmessage.adapter.ts': ['gated', 'a.loopmessage.com message/send: assertEgress + egressInit'],
  'src/modules/gateways/channels/adapters/google-chat.adapter.ts': ['gated', 'webhook_url: assertEgress + egressInit'],
  'src/modules/gateways/channels/adapters/irc.adapter.ts': ['gated', 'bridge webhook_url: assertEgress + egressInit'],
  'src/modules/gateways/channels/adapters/microsoft-teams.adapter.ts': ['gated', 'activity service_url: assertEgress + egressInit; JWKS/token are Microsoft constants'],
  'src/modules/gateways/channels/visitor-oauth.service.ts': ['gated', 'openid-client token/JWKS/userinfo: customFetch = safeFetch'],
  'src/modules/gateways/company-signin.service.ts': ['gated', 'Company OIDC discovery/token/JWKS: customFetch = safeFetch, every issuer URL gated and pinned'],
  'ee/modules/sso/sso.service.ts': ['gated', 'org OIDC issuer discovery + token/JWKS: customFetch = safeFetch (SSO_ALLOW_PRIVATE_URLS exempts the issuer host only)'],
  'ee/modules/audit-export/audit-stream.service.ts': ['gated', 'SIEM endpoint: decideEgress at save, pinned + redirect error at delivery'],

  // Constant vendor origins.
  'src/modules/auth/captcha.service.ts': ['vendor', 'Turnstile / hCaptcha / reCAPTCHA siteverify constants'],
  'src/modules/connections/rotation/rotation.http.ts': ['vendor', 'key-rotation calls to each vendor\'s fixed admin API'],
  'src/modules/files/storage.service.ts': ['operator', 'STORAGE_S3_ENDPOINT from the operator\'s environment'],
  'src/modules/hosted-runners/adapters/kubernetes/kube-api.client.ts': ['operator', 'hosted runner cluster API: the server URL of the platform pool\'s kubernetes connection, named by the operator (HOSTED_RUNNERS_CLUSTER_CONNECTION); an organization\'s own cluster is refused until phase 4. The kubernetes connection check (connection-validation.service) dials a user-supplied server through it only after guardUrl, with a DNS-pinned agent'],
  'src/modules/gateways/channels/channel-webhook-registrar.service.ts': ['vendor', 'Telegram / Twilio / Sendblue webhook registration APIs (api.sendblue.co)'],
  'src/modules/gateways/channels/discord-gateway.transport.ts': ['vendor', 'Discord gateway WebSocket URL from Discord\'s own /gateway/bot'],
  'src/modules/gateways/channels/adapters/discord.adapter.ts': ['vendor', 'discord.com API'],
  'src/modules/gateways/channels/adapters/email.adapter.ts': ['vendor', 'api.resend.com'],
  'src/modules/gateways/channels/adapters/slack.adapter.ts': ['vendor', 'slack.com API'],
  'src/modules/gateways/channels/adapters/sms.adapter.ts': ['vendor', 'api.twilio.com (accountSid is a path segment)'],
  'src/modules/gateways/channels/adapters/telegram.adapter.ts': ['vendor', 'api.telegram.org'],
  'src/modules/gateways/channels/adapters/whatsapp.adapter.ts': ['vendor', 'api.twilio.com'],
  'src/modules/gateways/channels/adapters/whatsapp-cloud.adapter.ts': ['vendor', 'graph.facebook.com'],
  'src/modules/memory/canonical/backends/vertex-memory-bank.backend.ts': ['vendor', '{location}-aiplatform.googleapis.com; location checked by assertGcpLocation'],
  'src/modules/model-deployments/adapters/vertex.adapter.ts': ['vendor', '{location}-aiplatform.googleapis.com; location checked by assertGcpLocation'],
  'src/modules/model-deployments/adapters/aws-bedrock-import.adapter.ts': ['vendor', 'bedrock.{region}.amazonaws.com; region checked by assertAwsRegion'],
  'src/modules/model-deployments/adapters/sagemaker.adapter.ts': ['vendor', 'api.sagemaker.{region}.amazonaws.com; region checked by assertAwsRegion'],
  'src/modules/model-deployments/adapters/nebius.adapter.ts': ['vendor', 'apiHost / dataPlaneHost held to https://*.nebius.com by nebiusOrigin'],
  'src/modules/model-deployments/adapters/azure-foundry.adapter.ts': ['vendor', 'management.azure.com / login.microsoftonline.com; scoring URIs are Azure\'s own answers'],
  'src/modules/model-deployments/adapters/baseten.adapter.ts': ['vendor', 'api.baseten.co; model hostnames are Baseten\'s answers'],
  'src/modules/model-deployments/adapters/digitalocean.adapter.ts': ['vendor', 'api.digitalocean.com'],
  'src/modules/model-deployments/adapters/fireworks.adapter.ts': ['vendor', 'api.fireworks.ai'],
  'src/modules/model-deployments/adapters/huggingface-endpoints.adapter.ts': ['vendor', 'api.endpoints.huggingface.cloud'],
  'src/modules/model-deployments/adapters/runpod.adapter.ts': ['vendor', 'rest.runpod.io / api.runpod.ai'],
  'src/modules/model-deployments/adapters/together.adapter.ts': ['vendor', 'api.together.xyz'],
  'src/modules/model-registry/hf-fetch.ts': ['vendor', 'Hugging Face hosts only, every hop re-gated and pinned'],

  // Not the server's requests.
  'src/modules/tools/cli-generator.service.ts': ['codegen', 'fetch inside a generated CLI script'],
  'src/modules/tools/codegen.service.ts': ['codegen', 'fetch inside a generated SDK'],
  'src/modules/gateways/channels/widget-script.ts': ['codegen', 'fetch inside the browser widget script'],
  'src/scripts/lifecycle-staging-verify.ts': ['operator', 'operator-run script against the operator\'s own staging URL'],
};

/** A direct transport call, not an import of one. `safeFetch(` and `this.fetchImpl(` are not matched. */
const TRANSPORT = new RegExp(
  [
    String.raw`\baxios(?:\.(?:get|post|put|patch|delete|head|request|create))?\(`,
    String.raw`(?:^|[^.\w])fetch\(`,
    String.raw`\(fetch as any\)\(`,
    String.raw`globalThis\.fetch\(`,
    String.raw`\bhttps?\.(?:get|request)\(`,
    String.raw`\b(?:net|tls)\.(?:connect|createConnection)\(`,
    String.raw`new WebSocket\(`,
    String.raw`\bnew (?:sdk\.)?S3Client\(`,
    String.raw`\boidc\.discovery\(`,
    String.raw`\bnew oidc\.Configuration\(`,
    String.raw`\bthis\.fetch\(`,
  ].join('|'),
  'm',
);

/** What proves a `gated` file goes through the shared guard. */
const USES_THE_GUARD =
  /\b(safeFetch|egressAxiosConfig|assertOutboundUrlAllowed|validateUrl|validateUrlAllowingPrivate|assertEgress|egressInit|pinnedRedirects|ssrfSafeDispatcher|ssrfSafeHttpsAgent|gatedConfig|decideEgress|guardUrl|capResponse|pinDns|assertSafeNextPageUrl)\b/;

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (['node_modules', '__tests__', 'test', 'migrations', '__fixtures__'].includes(name)) continue;
      productionFiles(p, out);
    } else if (name.endsWith('.ts') && !name.includes('.spec.') && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

const ROOT = join(SRC, '..');
const rel = (p: string) => p.slice(ROOT.length + 1).split(sep).join('/');

function filesWithTransports(): string[] {
  return [...productionFiles(SRC), ...productionFiles(EE)]
    .filter((p) => TRANSPORT.test(stripComments(readFileSync(p, 'utf8'))))
    .map(rel)
    .sort();
}

describe('every module that dials out is accounted for', () => {
  const found = filesWithTransports();

  it('has no unlisted transport: a new one must be routed through the guard or justified here', () => {
    const unlisted = found.filter((f) => !(f in INVENTORY));
    expect(unlisted).toEqual([]);
  });

  it('lists nothing that no longer dials out', () => {
    const stale = Object.keys(INVENTORY).filter((f) => !found.includes(f));
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(INVENTORY).filter(([, [kind]]) => kind === 'gated'))(
    '%s goes through the shared guard',
    (file) => {
      expect(stripComments(readFileSync(join(ROOT, file), 'utf8'))).toMatch(USES_THE_GUARD);
    },
  );

  it('the OIDC clients never fetch with the global fetch', () => {
    for (const file of ['ee/modules/sso/sso.service.ts', 'src/modules/gateways/channels/visitor-oauth.service.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8')).toMatch(/\[oidc\.customFetch\]/);
    }
  });

  it('region-spliced vendor hosts check the region', () => {
    for (const file of [
      'src/modules/model-deployments/adapters/vertex.adapter.ts',
      'src/modules/memory/canonical/backends/vertex-memory-bank.backend.ts',
    ]) {
      expect(readFileSync(join(ROOT, file), 'utf8')).toMatch(/assertGcpLocation\(/);
    }
    for (const file of [
      'src/modules/model-deployments/adapters/aws-bedrock-import.adapter.ts',
      'src/modules/model-deployments/adapters/sagemaker.adapter.ts',
    ]) {
      const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      // Every amazonaws.com URL template splices a checked region.
      const templates = src.match(/`https:\/\/[^`]*\$\{[^}]*\}\.amazonaws\.com[^`]*`/g) ?? [];
      expect(templates.length).toBeGreaterThan(0);
      for (const t of templates) expect(t).toMatch(/\$\{assertAwsRegion\(region\)\}/);
    }
  });

  it('actually finds the transports, so it cannot pass by reading nothing', () => {
    expect(found.length).toBeGreaterThanOrEqual(50);
    expect(found).toContain('src/modules/apis/apis-import.helper.ts');
    expect(found).toContain('ee/modules/sso/sso.service.ts');
  });

  /** The matcher's own red-check: the shapes it exists to catch. */
  it.each([
    ['bare axios', 'await axios.get(cfg.url)'],
    ['aliased fetch', 'const res = await (fetch as any)(target, init);'],
    ['global fetch', 'return fetch(url, { method: "POST" });'],
    ['raw http.get', 'const req = https.get(url, { agent }, cb);'],
    ['openid-client discovery', 'await oidc.discovery(new URL(issuer), id, secret);'],
    ['injected fetch', 'await this.fetch(url)'],
  ])('recognises %s', (_label, snippet) => {
    expect(TRANSPORT.test(snippet)).toBe(true);
  });

  it.each([
    ['the guarded client', 'await safeFetch(url, { maxBytes })'],
    ['an injected guarded fetch', 'await this.fetchImpl(url, init)'],
  ])('does not count %s as a direct transport', (_label, snippet) => {
    expect(TRANSPORT.test(snippet)).toBe(false);
  });
});
