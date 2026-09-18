import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertNoArgvSecrets,
  assertStdinIsPiped,
  csv,
  deployBody,
  formatAdapter,
  formatCard,
  formatCardDetail,
  formatDeploymentDetail,
  formatRoutePlan,
  formatSync,
  formatVersion,
  needArg,
  num,
  parseArgs,
  parseJsonObject,
  registerBody,
  registerEndpointBody,
  registerVersionBody,
  routePolicy,
  secretFields,
  setBody,
  unselectableReason,
} from '../index';
import { EXIT, EXIT_CODE_HELP, UsageError, describeError, exitCodeFor } from '../exit-codes';
import { VERSION, readVersion } from '../version';

describe('@almyty/models', () => {
  it('parses commands, positionals and flags', () => {
    const args = parseArgs(['scale', 'dep-1', '2', '--json']);
    expect(args).toEqual({ command: 'scale', positional: ['dep-1', '2'], flags: { json: true } });
  });

  it('never swallows the next argument after a boolean flag', () => {
    // `--selectable --json` and `--config-stdin` take no value, so the
    // following argument must stay the argument it was.
    expect(parseArgs(['list', '--selectable', '--status', 'active'])).toEqual({
      command: 'list', positional: [], flags: { selectable: true, status: 'active' },
    });
    expect(parseArgs(['deploy', 'hf://a/b@c', '--config-stdin', '--adapter', 'modal'])).toEqual({
      command: 'deploy', positional: ['hf://a/b@c'], flags: { 'config-stdin': true, adapter: 'modal' },
    });
  });

  it('stops parsing flags after --', () => {
    expect(parseArgs(['get', '--', '--odd-id'])).toEqual({ command: 'get', positional: ['--odd-id'], flags: {} });
  });

  it('refuses a non-numeric number instead of sending NaN', () => {
    expect(num({ context: '200000' }, 'context')).toBe(200000);
    expect(num({}, 'context')).toBeUndefined();
    // NaN survives JSON.stringify as null, so the API complained about the wrong thing.
    expect(() => num({ context: 'lots' }, 'context')).toThrow('--context must be a number, got lots');
    expect(() => registerBody(parseArgs(['register', '--name', 'n', '--provider', 'p', '--model', 'm', '--context', 'big']).flags)).toThrow('--context must be a number');
  });

  it('builds a register body and refuses a missing provider', () => {
    const flags = parseArgs(['register', '--name', 'Sonnet', '--provider', 'p1', '--model', 'claude-sonnet-5', '--tier', 'public', '--context', '200000']).flags;
    expect(registerBody(flags)).toEqual({ name: 'Sonnet', providerId: 'p1', vendorModelId: 'claude-sonnet-5', privacyTier: 'public', contextLength: 200000 });
    expect(() => registerBody(parseArgs(['register', '--name', 'x', '--model', 'm']).flags)).toThrow('--provider is required');
  });

  it('builds an endpoint registration with the key only when one was supplied', () => {
    const flags = parseArgs(['register-endpoint', '--name', 'box', '--url', 'https://vllm.internal/v1', '--model', 'llama', '--region', 'eu']).flags;
    expect(registerEndpointBody(flags)).toEqual({ name: 'box', url: 'https://vllm.internal/v1', vendorModelId: 'llama', region: 'eu' });
    // The key is no longer read from the flags: it arrives from a prompt or stdin.
    expect(registerEndpointBody(flags, 'k').apiKey).toBe('k');
    expect(registerEndpointBody({ ...flags, 'api-key': 'leaked' }).apiKey).toBeUndefined();
  });

  it('takes the model as the positional argument, because naming it is configuration', () => {
    const a = parseArgs(['deploy', 'hf://Qwen/Qwen3-0.6B@main', '--adapter', 'huggingface-endpoints', '--base', 'qwen3']);
    expect(deployBody(a.flags, a.positional)).toEqual({ providerType: 'huggingface-endpoints', model: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3' });

    const b = parseArgs(['deploy', 'fireworks://accounts/acme/models/qwen3', '--adapter', 'fireworks']);
    expect(deployBody(b.flags, b.positional)).toEqual({ providerType: 'fireworks', model: 'fireworks://accounts/acme/models/qwen3' });
  });

  it('still takes a registered version, and never sends both', () => {
    const flags = parseArgs(['deploy', '--model-version', 'v1', '--adapter', 'modal', '--desired', '{"replicas":1}', '--budget', 'b1']).flags;
    expect(deployBody(flags, [], { tokenId: 'a' })).toEqual({ modelVersionId: 'v1', providerType: 'modal', providerConfig: { tokenId: 'a' }, desired: { replicas: 1 }, budgetId: 'b1' });

    const both = parseArgs(['deploy', 'hf://Qwen/Qwen3-0.6B@main', '--model-version', 'v1', '--adapter', 'modal']);
    const body = deployBody(both.flags, both.positional);
    expect(body).toMatchObject({ modelVersionId: 'v1' });
    expect(body.model).toBeUndefined();
  });

  it('names the catalog card with --card, so --model is free for the model itself', () => {
    const a = parseArgs(['deploy', 'hf://Qwen/Qwen3-0.6B@main', '--adapter', 'modal', '--card', 'card-1']);
    expect(deployBody(a.flags, a.positional).modelId).toBe('card-1');
  });

  it('asks for the model rather than posting a body with neither', () => {
    expect(() => deployBody({ adapter: 'modal' }, [])).toThrow(/Name the model to run/);
  });

  it('rejects bad JSON, naming the flag it came from', () => {
    expect(() => parseJsonObject('{oops', '--config-file /tmp/c.json')).toThrow('--config-file /tmp/c.json must be valid JSON');
    expect(() => parseJsonObject('[1]', '--config-stdin')).toThrow('--config-stdin must be a JSON object');
    expect(parseJsonObject('{"tokenId":"a"}', '--config-stdin')).toEqual({ tokenId: 'a' });
  });

  // ── Secrets never travel on argv ──────────────────────────────────

  const modalSchema = {
    type: 'object',
    properties: {
      tokenId: { type: 'string' },
      tokenSecret: { type: 'string', 'x-secret': true },
    },
  };

  it('reads the secret fields out of an adapter config schema', () => {
    expect(secretFields(modalSchema)).toEqual(['tokenSecret']);
    expect(secretFields(undefined)).toEqual([]);
  });

  it('refuses an adapter secret passed with --config, and names the safe paths', () => {
    const fail = () => assertNoArgvSecrets(modalSchema, { tokenId: 'a', tokenSecret: 'shh' }, '--config', ['--config-file <path>', '--config-stdin', '--credential <id>']);
    expect(fail).toThrow(/tokenSecret is a secret/);
    expect(fail).toThrow(/--config-file/);
    expect(fail).toThrow(/--credential/);
  });

  it('never repeats the secret it refused', () => {
    try {
      assertNoArgvSecrets(modalSchema, { tokenSecret: 'do-not-print-me' }, '--config', ['--config-stdin']);
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.message).not.toContain('do-not-print-me');
    }
  });

  it('lets non-secret adapter config through on the command line', () => {
    expect(() => assertNoArgvSecrets(modalSchema, { tokenId: 'a' }, '--config', [])).not.toThrow();
    // An unknown adapter means no schema; the API validates the body anyway.
    expect(() => assertNoArgvSecrets(undefined, { anything: 1 }, '--config', [])).not.toThrow();
  });

  // ── Routing ───────────────────────────────────────────────────────

  it('splits comma lists and drops the empties', () => {
    expect(csv({ regions: 'eu-central, us-east ,' }, 'regions')).toEqual(['eu-central', 'us-east']);
    expect(csv({ regions: ' , ' }, 'regions')).toBeUndefined();
    expect(csv({}, 'regions')).toBeUndefined();
  });

  it('builds the same routing policy an llm_call node carries', () => {
    const flags = parseArgs([
      'route', '--objective', 'cheapest', '--tier', 'private_cloud', '--regions', 'eu-central,eu-west',
      '--needs', 'tools,vision', '--chain', 'card-a,card-b', '--budget-headroom', '500', '--prefer', 'openai,p-1',
    ]).flags;
    expect(routePolicy(flags)).toEqual({
      objective: 'cheapest',
      privacyTier: 'private_cloud',
      regions: ['eu-central', 'eu-west'],
      capabilities: { tools: true, vision: true },
      fallbackChain: ['card-a', 'card-b'],
      budgetHeadroomCents: 500,
      connectionPreference: ['openai', 'p-1'],
    });
    expect(routePolicy({})).toEqual({});
    expect(routePolicy({ pinned: 'card-a', objective: 'pinned' })).toEqual({ objective: 'pinned', pinnedModel: 'card-a' });
  });

  it('takes the full capability shape as JSON, but not alongside --needs', () => {
    expect(routePolicy({ capabilities: '{"tools":true,"vision":false}' }).capabilities).toEqual({ tools: true, vision: false });
    expect(() => routePolicy({ capabilities: '{"tools":true}', needs: 'vision' })).toThrow('contradict');
  });

  it('shows the order the router would try, and why it rejected the rest', () => {
    const rendered = formatRoutePlan({
      candidates: [
        { modelId: 'c1', name: 'Llama 3 8B', vendorModelId: 'llama-3-8b', providerType: 'openai', rationale: 'cheapest at $0.10 blended', blendedPricePerMTok: 0.1, privacyTier: 'private_cloud', region: 'eu-central' },
      ],
      rejected: [
        { modelId: 'c2', reason: 'no callable provider' },
        { modelId: 'c3', reason: 'privacy tier public exceeds the ceiling private_cloud' },
      ],
    });
    expect(rendered).toContain('1. Llama 3 8B');
    expect(rendered).toContain('cheapest at $0.10 blended');
    expect(rendered).toContain('Rejected 2:');
    expect(rendered).toContain('c2  no callable provider');
    expect(rendered).toContain('privacy tier public exceeds the ceiling');
  });

  it('says plainly when a policy resolves to nothing', () => {
    expect(formatRoutePlan({ candidates: [], rejected: [] })).toContain('No model satisfies this policy.');
    expect(formatRoutePlan({ candidates: [{ modelId: 'c1', name: 'n', vendorModelId: 'v', rationale: 'r', privacyTier: 'public' }], rejected: [] })).toContain('Nothing rejected.');
  });

  // ── Why a card is not usable ──────────────────────────────────────

  it('explains an unusable card by the first thing that disqualifies it', () => {
    expect(unselectableReason({ id: 'c1', status: 'inactive', metadata: { retiredReason: 'not listed by provider' } }))
      .toBe('status is inactive (not listed by provider)');
    expect(unselectableReason({ id: 'c1', status: 'active', validationStatus: 'passed' }))
      .toBe('nothing can call it: no provider row and no endpoint URL');
    expect(unselectableReason({ id: 'c1', status: 'active', providerId: 'p1', validationStatus: 'pending' }))
      .toContain('almyty models validate c1');
    expect(unselectableReason({ id: 'c1', status: 'active', endpointRef: { url: 'https://x/v1' }, validationStatus: 'failed', lastValidationError: 'MODEL_NOT_FOUND' }))
      .toContain('MODEL_NOT_FOUND');
  });

  it('formats a card with its selectability and price source', () => {
    const line = formatCard({ id: 'c1', name: 'Llama', vendorModelId: 'llama-3-8b', privacyTier: 'private_cloud', region: 'eu', status: 'active', providerId: 'p1', effectivePricing: { inPerMTok: 0.1, outPerMTok: 0.2 }, pricingSource: 'adapter', selectable: false, validationStatus: 'failed', lastValidationError: 'timeout' });
    expect(line).toContain('llama-3-8b');
    expect(line).toContain('private_cloud/eu');
    expect(line).toContain('$0.1/$0.2 per M (adapter)');
    expect(line).toContain('not selectable: no passed validation run (failed: timeout)');
    expect(formatCard({ id: 'c2', name: 'X', vendorModelId: 'x', privacyTier: 'public', selectable: true })).toContain('selectable');
  });

  it('shows in detail everything that decides whether the router may pick a card', () => {
    const detail = formatCardDetail({
      id: 'c1', name: 'Llama 3 8B', vendorModelId: 'llama-3-8b', status: 'active', selectable: true,
      providerId: 'p1', providerType: 'openai', privacyTier: 'private_cloud', region: 'eu-central',
      capabilities: { tools: true, vision: false }, contextLength: 8192,
      effectivePricing: { inPerMTok: 0.1, outPerMTok: 0.2 }, pricingSource: 'feed:litellm',
      validationStatus: 'passed', lastValidatedAt: '2026-09-17T10:00:00Z', measuredLatencyMs: { p50: 420, p95: 900 },
    });
    expect(detail).toContain('selectable    yes');
    expect(detail).toContain('provider p1 (openai)');
    expect(detail).toContain('tools');
    expect(detail).not.toContain('vision');
    expect(detail).toContain('feed:litellm');
    expect(detail).toContain('p50 420 ms');

    const broken = formatCardDetail({ id: 'c2', name: 'Retired', vendorModelId: 'old', status: 'inactive', selectable: false, privacyTier: 'public', metadata: { retiredReason: 'provider deleted' } });
    expect(broken).toContain('Not a routing candidate yet.');
    expect(broken).toContain('provider deleted');
  });

  it('warns when the two price feeds disagree, because the card carries that', () => {
    const detail = formatCardDetail({ id: 'c1', name: 'n', vendorModelId: 'v', status: 'active', selectable: true, privacyTier: 'public', providerId: 'p', validationStatus: 'passed', metadata: { pricingDisagreement: { litellm: 1, openrouter: 3 } } });
    expect(detail).toContain('the feeds disagree');
  });

  // ── set ───────────────────────────────────────────────────────────

  it('builds a card update, and refuses one that changes nothing', () => {
    expect(setBody({ tier: 'local', region: 'on-prem' })).toEqual({ privacyTier: 'local', region: 'on-prem' });
    expect(setBody({ status: 'inactive' })).toEqual({ status: 'inactive' });
    expect(() => setBody({})).toThrow('nothing to set');
  });

  it('takes a price override as a pair, never as half a pair', () => {
    expect(setBody({ 'price-in': '0.5', 'price-out': '1.5' })).toEqual({ pricingOverride: { inPerMTok: 0.5, outPerMTok: 1.5 } });
    // Half an override would price input by hand and output from the feed.
    expect(() => setBody({ 'price-in': '0.5' })).toThrow('needs both --price-in and --price-out');
    expect(setBody({ 'clear-price': true })).toEqual({ pricingOverride: null });
    expect(() => setBody({ 'clear-price': true, 'price-in': '1', 'price-out': '2' })).toThrow('contradict');
  });

  // ── sync, adapters, deployments ───────────────────────────────────

  it('reports every kind of change a sync made, not only what it created', () => {
    const rendered = formatSync({
      created: [{ name: 'New', vendorModelId: 'new-1', id: 'c9' }],
      skipped: 3,
      retired: [{ name: 'Gone', vendorModelId: 'gone-1', metadata: { retiredReason: 'not listed by provider' } }],
      reinstated: [{ name: 'Back', vendorModelId: 'back-1' }],
    });
    expect(rendered).toContain('1 card(s) created, 3 already present, 1 retired, 1 reinstated.');
    expect(rendered).toContain('+ New');
    expect(rendered).toContain('- Gone');
    expect(rendered).toContain('not listed by provider');
    expect(rendered).toContain('~ Back');
  });

  it('reports the per-provider summary a sync with no provider id returns', () => {
    const rendered = formatSync({ created: [], skipped: 0, retired: [], reinstated: [], providers: { 'p-1': { created: 2, skipped: 1, retired: 0, reinstated: 0 }, 'p-2': { error: 'provider unreachable' } } });
    expect(rendered).toContain('Per provider:');
    expect(rendered).toContain('p-1  created 2');
    expect(rendered).toContain('p-2  error: provider unreachable');
  });

  it('shows what an adapter can run and which of its config fields are secret', () => {
    const rendered = formatAdapter({ key: 'modal', displayName: 'Modal', capabilities: { scaleToZero: true }, modelSchemes: ['hf://', 's3://'], configSchema: modalSchema });
    // modelSchemes is what keeps a deploy from being refused with ADAPTER_UNSUPPORTED_SOURCE.
    expect(rendered).toContain('runs        hf:// s3://');
    expect(rendered).toContain('scaleToZero=true');
    expect(rendered).toContain('secret config tokenSecret');
    expect(rendered).toContain('--config-file');
  });

  it('shows a deployment in detail using the fields the API returns', () => {
    const rendered = formatDeploymentDetail({
      id: 'd1', providerType: 'modal', state: 'ready', modelRef: 'hf://Qwen/Qwen3-0.6B@main', modelBase: 'qwen3',
      desired: { replicas: 1 }, actual: { state: 'ready', replicas: 1, url: 'https://x.modal.run', spentCents: 250, ratePerHourCents: 30 },
      budgetId: 'b1', lastReconcileAt: '2026-09-17T10:00:00Z',
    });
    expect(rendered).toContain('hf://Qwen/Qwen3-0.6B@main');
    expect(rendered).toContain('endpoint    https://x.modal.run');
    expect(rendered).toContain('2.50 USD');
    expect(rendered).toContain('0.30 USD per hour');
    expect(rendered).toContain('scales this to zero');
    expect(formatDeploymentDetail({ id: 'd2', providerType: 'stub', state: 'pending', desired: {} })).toContain('(not reconciled yet)');
  });

  it('builds a version registration and formats a version', () => {
    const flags = parseArgs(['register-version', '--name', 'qwen tiny', '--uri', 'hf://Qwen/Qwen3-0.6B-GGUF@main', '--base', 'qwen3-0.6b', '--quantizations', 'Q4_K_M, Q8_0']).flags;
    expect(registerVersionBody(flags)).toEqual({ name: 'qwen tiny', registryUri: 'hf://Qwen/Qwen3-0.6B-GGUF@main', base: 'qwen3-0.6b', quantizations: ['Q4_K_M', 'Q8_0'] });
    expect(() => registerVersionBody({ name: 'x' })).toThrow('--uri is required');
    expect(formatVersion({ id: 'v1', name: 'qwen tiny', base: 'qwen3-0.6b', sizeBytes: '1500000000', quantizations: ['Q4_K_M'], registryUri: 's3://r/q@e' })).toContain('1.50 GB');
  });

  it('says which argument is missing instead of sending the string "undefined" to the API', () => {
    expect(() => needArg([], 0, 'card id', 'validate <id>')).toThrow(/card id is required/);
    expect(() => needArg([], 0, 'card id', 'validate <id>')).toThrow(/almyty models validate <id>/);
    expect(needArg(['c1'], 0, 'card id', 'validate <id>')).toBe('c1');
  });
});

// ── Conventions shared with the other almyty CLIs ─────────────────

describe('conventions', () => {
  it('accepts --flag=value as well as --flag value', () => {
    // With only the space form, --input='{"a":1}' became a flag literally
    // named `input={"a":1}` and the value was silently dropped.
    expect(parseArgs(['list', '--status=active']).flags).toEqual({ status: 'active' });
    expect(parseArgs(['deploy', 'hf://a/b@c', '--adapter=modal']).flags).toEqual({ adapter: 'modal' });
    expect(parseArgs(['route', '--needs=tools,vision']).flags).toEqual({ needs: 'tools,vision' });
    expect(routePolicy(parseArgs(['route', '--needs=tools']).flags).capabilities).toEqual({ tools: true });
  });

  it('keeps an empty value an empty value', () => {
    expect(parseArgs(['set', 'c1', '--region=']).flags).toEqual({ region: '' });
  });

  it('pins the exit-code table every almyty CLI shares', () => {
    // A script switching on $? must see the same number from every binary.
    expect(EXIT).toEqual({ OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, NOT_FOUND: 4, FAILED: 5 });
  });

  it('exits 2 for a usage error, so a bad flag is not mistaken for a failure', () => {
    expect(exitCodeFor(new UsageError('--context must be a number, got lots'))).toBe(EXIT.USAGE);
    expect(exitCodeFor(new Error('--adapter is required'))).toBe(EXIT.USAGE);
  });

  it('exits 3 when the credential is the problem, naming the login command', () => {
    // The shared client turns a 401 into this exact message.
    expect(exitCodeFor(new Error('Authentication failed. Run: npx @almyty/auth login'))).toBe(EXIT.AUTH);
    expect(exitCodeFor(new Error('API error 403: forbidden'))).toBe(EXIT.AUTH);
  });

  it('exits 4 for a missing thing and 5 for an operation that ran and failed', () => {
    expect(exitCodeFor(new Error('API error 404: Not Found'))).toBe(EXIT.NOT_FOUND);
    expect(exitCodeFor(new Error('API error 422: the provider rejected the model id'))).toBe(EXIT.FAILED);
    expect(exitCodeFor(new Error('API error 500: boom'))).toBe(EXIT.FAILED);
  });

  it('exits 1 for anything it cannot classify', () => {
    expect(exitCodeFor(new Error('socket hang up'))).toBe(EXIT.ERROR);
    expect(exitCodeFor('a bare string')).toBe(EXIT.ERROR);
  });

  it('documents every code in --help', () => {
    for (const code of [0, 1, 2, 3, 4, 5]) expect(EXIT_CODE_HELP).toContain(`  ${code}  `);
    expect(EXIT_CODE_HELP).toContain('almyty auth login');
  });
});

describe('error messages', () => {
  it('names the login command instead of echoing a 401 body', () => {
    const text = describeError(new Error('Authentication failed. Run: npx @almyty/auth login'));
    expect(text).toContain('npx @almyty/auth login');
    expect(text).toContain('ALMYTY_TOKEN');
  });

  it('says which host could not be reached, because "fetch failed" says nothing', () => {
    const text = describeError(new TypeError('fetch failed'), 'https://api.almyty.com');
    expect(text).toContain('Could not reach the almyty API at https://api.almyty.com');
    expect(text).toContain('ALMYTY_URL');
    // And it still works without knowing the URL.
    expect(describeError(new TypeError('fetch failed'))).toContain('Could not reach the almyty API:');
  });

  it('turns a refused connection into the same advice', () => {
    expect(describeError(new Error('connect ECONNREFUSED 127.0.0.1:9'))).toContain('ALMYTY_URL');
  });

  it('explains a 403 as a permission problem, not a login problem', () => {
    const text = describeError(new Error('API error 403: Forbidden'));
    expect(text).toContain('lacks permission');
    expect(text).not.toContain('auth login');
  });

  it('explains a 404 as a wrong id rather than a broken tool', () => {
    expect(describeError(new Error('API error 404: Not Found'))).toContain('another organization');
  });

  it('points a missing file at the flag that named it', () => {
    expect(describeError(new Error("ENOENT: no such file or directory, open '/tmp/k.json'"))).toMatch(/--input-file or --config-file/);
  });

  it('passes an unclassifiable message through unchanged', () => {
    expect(describeError(new Error('something specific the API said'))).toBe('something specific the API said');
  });
});

describe('stdin and the terminal', () => {
  it('refuses --config-stdin when stdin is the terminal, instead of hanging', () => {
    const wasTty = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      expect(() => assertStdinIsPiped('--config-stdin')).toThrow(/would wait forever/);
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      expect(() => assertStdinIsPiped('--config-stdin')).not.toThrow();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: wasTty, configurable: true });
    }
  });
});

describe('version', () => {
  it('reads the version from package.json rather than a constant that drifts', () => {
    // models-cli shipped `--version` 0.1.0 while the package was 1.2.0.
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('falls back rather than crashing when package.json cannot be read', () => {
    expect(readVersion('9.9.9')).toMatch(/^\d+\.\d+\.\d+/);
  });
});
