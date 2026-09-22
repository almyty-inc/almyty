#!/usr/bin/env node
/**
 * @almyty/models: the model catalog from the terminal.
 *
 * Support in almyty is registry data, never a code list: a model is usable
 * when its card exists, has something that can call it, is active, and has
 * one passed validation run. `list` and `get` say which of those is missing,
 * and `route` answers the question a list cannot — what a routing policy
 * would pick right now, and why it rejected the rest. See docs/models.md.
 *
 * Adapter configuration and endpoint keys are secrets, so they are never
 * taken from argv: argv is readable through `ps` and lands in shell history.
 */
import { createInterface } from 'readline';
import { readFileSync } from 'fs';
import { AlmytyClient, resolveCredentialsOrExit } from '@almyty/client';
import { EXIT, EXIT_CODE_HELP, UsageError, describeError, exitCodeFor } from './exit-codes.js';
import { VERSION } from './version.js';


export interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that never take a value, so they never swallow the next argument. */
const BOOLEAN_FLAGS = new Set(['json', 'selectable', 'config-stdin', 'api-key-stdin', 'clear-price']);

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { result.flags.help = true; continue; }
    if (arg === '-v') { result.flags.version = true; continue; }
    if (arg === '--') {
      // Everything after `--` is positional, flags included.
      result.positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      // `--flag=value` as well as `--flag value`. With only the space form,
      // `--input='{"a":1}'` became a flag literally named `input={"a":1}`
      // and the value was dropped without a word.
      const eq = body.indexOf('=');
      if (eq !== -1) { result.flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      if (body === 'help' || body === 'version') { result.flags[body] = true; continue; }
      if (BOOLEAN_FLAGS.has(body)) { result.flags[body] = true; continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { result.flags[body] = next; i++; }
      else result.flags[body] = true;
      continue;
    }
    if (!result.command) result.command = arg;
    else result.positional.push(arg);
  }
  return result;
}

function printHelp(): void {
  console.log(`
@almyty/models v${VERSION}

A model is usable when its card is active, has something that can call it,
and has one passed validation run. Nothing else makes it selectable, so
\`list\` and \`get\` report which of those is missing rather than a name alone.

Usage:
  npx @almyty/models <command> [options]

Catalog:
  list [--selectable] [--status active|inactive|error|deploying]
       [--tier public|private_cloud|local] [--provider <providerId>]
                                       List cards; each line says selectable, or why not
  get <id>                             One card in full: capabilities, pricing, validation run
  register --name <n> --provider <providerId> --model <vendorModelId>
           [--tier public|private_cloud|local] [--region <r>] [--context <n>]
                                       Register a card against a stored LLM provider
  register-endpoint --name <n> --url <baseUrl> --model <vendorModelId>
           [--api-key-stdin] [--tier <t>] [--region <r>] [--context <n>]
                                       Register any OpenAI-compatible server you run.
                                       The key is prompted, or read with --api-key-stdin.
  set <id> [--name <n>] [--tier <t>] [--region <r>] [--context <n>]
           [--status active|inactive|error|deploying]
           [--price-in <usdPerMTok> --price-out <usdPerMTok>] [--clear-price]
                                       Change a card. A price pair is an override that
                                       wins over the automatic feed; --clear-price drops it.
  sync [providerId]                    Import what a provider lists as unvalidated cards.
                                       With no id, every active provider of the organization.
  validate <id>                        One real short call. Passing is what makes a card
                                       selectable. Exits non-zero when it fails.
  delete <id>                          Remove a card

Routing (nothing is called; this plans):
  route [--objective cheapest|fastest|pinned] [--tier <t>] [--regions <a,b>]
        [--needs tools,vision,reasoning] [--capabilities '<json>']
        [--pinned <card id or vendor model id>] [--chain <a,b>]
        [--budget-headroom <cents>] [--prefer <providerId or type,...>]
                                       What this policy would choose right now, in order,
                                       and every card it rejected with the reason.
                                       This is how to answer "why not that model".

Versions (optional: register an artifact only for lineage and evals on it):
  versions                             Registered model versions
  register-version --name <n> --uri <pinned uri> [--base <b>] [--quantizations <q1,q2>]
                                       hf://org/repo@sha | s3://bucket/key@etag
                                       gs://bucket/key@gen | file:///path@sha

Deployments:
  adapters                             Registered adapters: what each can run (modelSchemes),
                                       its capabilities, and which config fields are secret
  deploy <model> --adapter <key> [--base <b>] [--config-file <path>] [--config-stdin]
         [--desired '<json>'] [--credential <connectionId>] [--budget <id>] [--card <cardId>]
  deploy --model-version <id> --adapter <key> [...]
                                       <model> is where the model lives:
                                         hf://org/repo@sha       a Hugging Face repository
                                         s3://bucket/prefix@etag, gs://bucket/prefix@gen,
                                         file:///path@sha
                                         bedrock:// sagemaker:// vertex:// foundry://
                                         azureml:// fireworks:// together:// baseten://
                                                                 a model already on that platform
                                       \`adapters\` lists what each provider accepts; one that
                                       cannot read your source is refused before anything runs.
                                       Prefer --credential (a connection made with
                                       \`almyty connections connect\`) over pasting a key.
  deployments                          List deployments: desired vs actual, state, spend
  deployment <id>                      One deployment in full
  scale <deploymentId> <replicas>      Set desired replicas; 0 scales to zero
  teardown <deploymentId>              Tear the endpoint down; weights stay in the registry

Options:
  --json                               Undecorated JSON on stdout, for scripts
  -h, --help                           This help
  -v, --version                        Print the version

Environment:
  ALMYTY_TOKEN                         Token override (skips ~/.almyty/credentials.json)
  ALMYTY_URL                           API URL override
  NO_COLOR                             Honoured: this tool never colours its output

Exit codes:
${EXIT_CODE_HELP}
`);
}

function str(flags: ParsedArgs['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function need(flags: ParsedArgs['flags'], key: string): string {
  const v = str(flags, key);
  if (!v) throw new UsageError(`--${key} is required`);
  return v;
}

/**
 * A number, or a message. `--context abc` used to become NaN, which
 * JSON.stringify turns into null, so the API saw a field it could not
 * explain and answered about the wrong thing.
 */
export function num(flags: ParsedArgs['flags'], key: string): number | undefined {
  const raw = str(flags, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${key} must be a number, got ${raw}`);
  return n;
}

/** Say which positional is missing instead of sending "undefined" to the API. */
export function needArg(positional: string[], index: number, name: string, usage: string): string {
  const v = positional[index];
  if (!v) throw new UsageError(`${name} is required\n  usage: almyty models ${usage}`);
  return v;
}

export function parseJsonObject(raw: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`${flag} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError(`${flag} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function json(flags: ParsedArgs['flags'], key: string): Record<string, unknown> | undefined {
  const v = str(flags, key);
  if (!v) return undefined;
  try {
    return parseJsonObject(v, `--${key}`);
  } catch {
    throw new UsageError(`--${key} must be valid JSON`);
  }
}

/** A comma-separated list, trimmed, without the empties. */
export function csv(flags: ParsedArgs['flags'], key: string): string[] | undefined {
  const raw = str(flags, key);
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

/** Names of the `x-secret` properties of an adapter's config schema. */
export function secretFields(schema: any): string[] {
  const props: Record<string, any> = schema?.properties ?? {};
  return Object.entries(props).filter(([, def]) => def?.['x-secret'] === true).map(([key]) => key);
}

/**
 * Refuse a secret that arrived on the command line. argv is readable by any
 * process through `ps`, is written to shell history and is echoed by most CI
 * runners, so a key that travelled that way has to be treated as disclosed.
 */
export function assertNoArgvSecrets(schema: any, config: Record<string, unknown>, flag: string, alternatives: string[]): void {
  const offending = secretFields(schema).filter((f) => config[f] !== undefined);
  if (offending.length === 0) return;
  throw new UsageError(
    `${offending.join(', ')} ${offending.length === 1 ? 'is a secret' : 'are secrets'} and ${flag} puts it in your shell history and in \`ps\`.\n` +
    alternatives.map((a) => `  ${a}`).join('\n'),
  );
}

/** Request bodies are built from flags here so they can be checked without a network. */
export function registerBody(flags: ParsedArgs['flags']): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: need(flags, 'name'),
    providerId: need(flags, 'provider'),
    vendorModelId: need(flags, 'model'),
  };
  if (str(flags, 'tier')) body.privacyTier = str(flags, 'tier');
  if (str(flags, 'region')) body.region = str(flags, 'region');
  const context = num(flags, 'context');
  if (context !== undefined) body.contextLength = context;
  return body;
}

export function registerEndpointBody(flags: ParsedArgs['flags'], apiKey?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: need(flags, 'name'),
    url: need(flags, 'url'),
    vendorModelId: need(flags, 'model'),
  };
  if (apiKey) body.apiKey = apiKey;
  if (str(flags, 'tier')) body.privacyTier = str(flags, 'tier');
  if (str(flags, 'region')) body.region = str(flags, 'region');
  const context = num(flags, 'context');
  if (context !== undefined) body.contextLength = context;
  return body;
}

/** A card update. Refuses an empty one rather than sending a PATCH that does nothing. */
export function setBody(flags: ParsedArgs['flags']): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (str(flags, 'name')) body.name = str(flags, 'name');
  if (str(flags, 'tier')) body.privacyTier = str(flags, 'tier');
  if (str(flags, 'region')) body.region = str(flags, 'region');
  if (str(flags, 'status')) body.status = str(flags, 'status');
  const context = num(flags, 'context');
  if (context !== undefined) body.contextLength = context;
  const inPerMTok = num(flags, 'price-in');
  const outPerMTok = num(flags, 'price-out');
  if (flags['clear-price']) {
    if (inPerMTok !== undefined || outPerMTok !== undefined) throw new UsageError('--clear-price and --price-in/--price-out contradict each other');
    body.pricingOverride = null;
  } else if (inPerMTok !== undefined || outPerMTok !== undefined) {
    // A one-sided override would silently price half the call from the feed
    // and half by hand, which nobody means.
    if (inPerMTok === undefined || outPerMTok === undefined) throw new UsageError('a price override needs both --price-in and --price-out');
    body.pricingOverride = { inPerMTok, outPerMTok };
  }
  if (Object.keys(body).length === 0) throw new UsageError('nothing to set; pass at least one of --name --tier --region --context --status --price-in/--price-out --clear-price');
  return body;
}

/**
 * A routing policy built from flags, for `route`. Same shape as the policy an
 * llm_call node carries, so what this previews is what a run would do.
 */
export function routePolicy(flags: ParsedArgs['flags']): Record<string, unknown> {
  const policy: Record<string, unknown> = {};
  if (str(flags, 'objective')) policy.objective = str(flags, 'objective');
  if (str(flags, 'tier')) policy.privacyTier = str(flags, 'tier');
  const regions = csv(flags, 'regions');
  if (regions) policy.regions = regions;
  const chain = csv(flags, 'chain');
  if (chain) policy.fallbackChain = chain;
  const prefer = csv(flags, 'prefer');
  if (prefer) policy.connectionPreference = prefer;
  if (str(flags, 'pinned')) policy.pinnedModel = str(flags, 'pinned');
  const headroom = num(flags, 'budget-headroom');
  if (headroom !== undefined) policy.budgetHeadroomCents = headroom;

  // Two ways to say the same thing: a JSON object for the full shape, and
  // --needs for the common case of "these must be true".
  const capabilities = json(flags, 'capabilities');
  const needs = csv(flags, 'needs');
  if (capabilities && needs) throw new UsageError('--capabilities and --needs contradict each other; use one');
  if (capabilities) policy.capabilities = capabilities;
  else if (needs) policy.capabilities = Object.fromEntries(needs.map((n) => [n, true]));
  return policy;
}

/**
 * Naming the model is configuration, so the model reference is the
 * positional argument: `deploy hf://org/repo@sha --adapter huggingface-endpoints`.
 * `--model-version` is the other way in, for people who registered an
 * artifact to get lineage and evaluation history with it.
 */
export function deployBody(
  flags: ParsedArgs['flags'],
  positional: string[] = [],
  providerConfig?: Record<string, unknown>,
): Record<string, unknown> {
  const model = positional[0] ?? str(flags, 'model');
  const modelVersion = str(flags, 'model-version');
  if (!model && !modelVersion) {
    throw new UsageError('Name the model to run (deploy hf://org/repo@sha --adapter <key>), or pass --model-version <id>.');
  }
  const body: Record<string, unknown> = { providerType: need(flags, 'adapter') };
  if (modelVersion) body.modelVersionId = modelVersion;
  else body.model = model;
  if (str(flags, 'base')) body.base = str(flags, 'base');
  const desired = json(flags, 'desired');
  if (providerConfig && Object.keys(providerConfig).length > 0) body.providerConfig = providerConfig;
  if (desired) body.desired = desired;
  if (str(flags, 'credential')) body.credentialId = str(flags, 'credential');
  if (str(flags, 'budget')) body.budgetId = str(flags, 'budget');
  if (str(flags, 'card')) body.modelId = str(flags, 'card');
  return body;
}

export function registerVersionBody(flags: ParsedArgs['flags']): Record<string, unknown> {
  const body: Record<string, unknown> = { name: need(flags, 'name'), registryUri: need(flags, 'uri') };
  if (str(flags, 'base')) body.base = str(flags, 'base');
  if (str(flags, 'quantizations')) body.quantizations = String(str(flags, 'quantizations')).split(',').map((s) => s.trim()).filter(Boolean);
  return body;
}

export function formatVersion(v: any): string {
  const size = v.sizeBytes ? `  ${(Number(v.sizeBytes) / 1e9).toFixed(2)} GB` : '';
  const q = v.quantizations?.length ? `  [${v.quantizations.join(', ')}]` : '';
  return `${v.name}  ${v.base}${size}${q}\n    ${v.id}  ${v.registryUri}`;
}

/**
 * Why a card is not selectable, in the order the platform checks it. A card
 * that lists but cannot be picked is the thing people actually need
 * explained, and "validation: pending" alone does not explain a retired
 * model or one whose provider row went away.
 */
export function unselectableReason(c: any): string {
  if (c.status && c.status !== 'active') {
    const retired = c.metadata?.retiredReason;
    return `status is ${c.status}${retired ? ` (${retired})` : ''}`;
  }
  if (!c.providerId && !c.endpointRef?.url) return 'nothing can call it: no provider row and no endpoint URL';
  if (c.validationStatus !== 'passed') {
    const err = c.lastValidationError ? `: ${c.lastValidationError}` : '';
    const status = c.validationStatus ?? 'pending';
    return `no passed validation run (${status}${err}) — run: almyty models validate ${c.id}`;
  }
  return 'the catalog does not consider it selectable';
}

export function formatCard(c: any): string {
  const price = c.effectivePricing ? `$${c.effectivePricing.inPerMTok}/$${c.effectivePricing.outPerMTok} per M (${c.pricingSource})` : 'unpriced';
  const flag = c.selectable ? 'selectable' : `not selectable: ${unselectableReason(c)}`;
  return `${c.name}  [${c.vendorModelId}]  ${c.privacyTier}${c.region ? `/${c.region}` : ''}  ${price}\n    ${c.id}  ${flag}`;
}

/** The detail view, for `get`: everything that decides whether the router may pick it. */
export function formatCardDetail(c: any): string {
  const caps = c.capabilities && Object.keys(c.capabilities).length
    ? Object.entries(c.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ') || '(none declared true)'
    : '(none declared)';
  const lines = [
    `${c.name}`,
    `  id            ${c.id}`,
    `  vendor id     ${c.vendorModelId}`,
    `  status        ${c.status ?? 'unknown'}`,
    `  selectable    ${c.selectable ? 'yes' : `no — ${unselectableReason(c)}`}`,
    `  called via    ${c.providerId ? `provider ${c.providerId}${c.providerType ? ` (${c.providerType})` : ''}` : c.endpointRef?.url ? `endpoint ${c.endpointRef.url}` : 'nothing'}`,
    `  privacy       ${c.privacyTier}${c.region ? ` / ${c.region}` : ''}`,
    `  capabilities  ${caps}`,
    `  context       ${c.contextLength ?? 'unknown'}`,
    `  pricing       ${c.effectivePricing ? `$${c.effectivePricing.inPerMTok} in / $${c.effectivePricing.outPerMTok} out per M tokens (${c.pricingSource})` : 'unpriced'}`,
  ];
  if (c.pricingOverride) lines.push('                (a manual override is set; --clear-price drops it back to the feed)');
  if (c.metadata?.pricingDisagreement) lines.push(`  price warning the feeds disagree: ${JSON.stringify(c.metadata.pricingDisagreement)}`);
  lines.push(`  validation    ${c.validationStatus ?? 'pending'}${c.lastValidatedAt ? `, last ${c.lastValidatedAt}` : ', never run'}`);
  if (c.lastValidationError) lines.push(`  last error    ${c.lastValidationError}`);
  if (c.measuredLatencyMs) lines.push(`  latency       p50 ${c.measuredLatencyMs.p50 ?? '?'} ms, p95 ${c.measuredLatencyMs.p95 ?? '?'} ms`);
  if (c.deploymentId) lines.push(`  deployment    ${c.deploymentId}`);
  if (c.modelVersionId) lines.push(`  version       ${c.modelVersionId}`);
  if (!c.selectable) lines.push('', `Not a routing candidate yet. ${unselectableReason(c)}`);
  return lines.join('\n');
}

/**
 * The route preview. Candidates in the order the router would try them, then
 * every card it would not try and why, which is the only honest answer to
 * "why did it not pick that model".
 */
export function formatRoutePlan(plan: any): string {
  const lines: string[] = [];
  if (!plan.candidates?.length) {
    lines.push('No model satisfies this policy.');
  } else {
    lines.push(`${plan.candidates.length} candidate(s), in the order they would be tried:`);
    plan.candidates.forEach((c: any, i: number) => {
      const price = c.blendedPricePerMTok != null ? `$${c.blendedPricePerMTok} per M blended` : 'unpriced';
      lines.push(`  ${i + 1}. ${c.name}  [${c.vendorModelId}]  ${c.providerType ?? 'no provider type'}  ${c.privacyTier}${c.region ? `/${c.region}` : ''}  ${price}`);
      lines.push(`     ${c.modelId}  ${c.rationale}`);
    });
  }
  if (plan.rejected?.length) {
    lines.push('', `Rejected ${plan.rejected.length}:`);
    for (const r of plan.rejected) lines.push(`  ${r.modelId}  ${r.reason}`);
  } else {
    lines.push('', 'Nothing rejected.');
  }
  return lines.join('\n');
}

export function formatAdapter(a: any): string {
  const caps = Object.entries(a.capabilities ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  const schemes = a.modelSchemes?.length ? a.modelSchemes.join(' ') : '(none declared)';
  const secrets = secretFields(a.configSchema);
  const lines = [
    `${a.key}  ${a.displayName}`,
    `    runs        ${schemes}`,
    `    capabilities ${caps}`,
  ];
  if (secrets.length) lines.push(`    secret config ${secrets.join(', ')}  (pass with --config-file or --config-stdin, or use --credential)`);
  return lines.join('\n');
}

export function formatDeployment(d: any): string {
  const spend = d.actual?.spentCents != null ? `  spent ${(d.actual.spentCents / 100).toFixed(2)} USD` : '';
  return `${d.id}  ${d.providerType}  ${d.state}  replicas ${d.actual?.replicas ?? '?'}/${d.desired?.replicas ?? '?'}${spend}${d.lastError ? `\n    ${d.lastError}` : ''}`;
}

export function formatDeploymentDetail(d: any): string {
  const lines = [
    `${d.id}`,
    `  adapter     ${d.providerType}`,
    `  state       ${d.state}`,
    `  model       ${d.modelRef ?? d.modelVersionId ?? 'unknown'}${d.modelBase ? `  base ${d.modelBase}` : ''}`,
    `  desired     ${JSON.stringify(d.desired ?? {})}`,
    `  actual      ${d.actual ? `${d.actual.state ?? '?'}  replicas ${d.actual.replicas ?? '?'}${d.actual.hardware ? `  ${d.actual.hardware}` : ''}${d.actual.region ? `  ${d.actual.region}` : ''}` : '(not reconciled yet)'}`,
  ];
  if (d.actual?.message) lines.push(`  message     ${d.actual.message}`);
  if (d.actual?.url) lines.push(`  endpoint    ${d.actual.url}`);
  if (d.actual?.openAiBase) lines.push(`  openai base ${d.actual.openAiBase}`);
  if (d.modelId) lines.push(`  card        ${d.modelId}`);
  if (d.budgetId) lines.push(`  budget      ${d.budgetId}  (reaching it scales this to zero)`);
  if (d.actual?.spentCents != null) lines.push(`  spend       ${(d.actual.spentCents / 100).toFixed(2)} USD${d.actual.ratePerHourCents != null ? `, ${(d.actual.ratePerHourCents / 100).toFixed(2)} USD per hour` : ''}`);
  if (d.lastReconcileAt) lines.push(`  reconciled  ${d.lastReconcileAt}`);
  if (d.lastError) lines.push(`  last error  ${d.lastError}`);
  return lines.join('\n');
}

/** `sync` reports every kind of change, not only what it created. */
export function formatSync(data: any): string {
  const lines = [
    `${data.created?.length ?? 0} card(s) created, ${data.skipped ?? 0} already present, ` +
    `${data.retired?.length ?? 0} retired, ${data.reinstated?.length ?? 0} reinstated.`,
  ];
  for (const c of data.created ?? []) lines.push(`  + ${c.name}  [${c.vendorModelId}]  ${c.id}`);
  for (const c of data.retired ?? []) lines.push(`  - ${c.name}  [${c.vendorModelId}]  ${c.metadata?.retiredReason ?? 'retired'}`);
  for (const c of data.reinstated ?? []) lines.push(`  ~ ${c.name}  [${c.vendorModelId}]  listed again`);
  if (data.providers) {
    lines.push('', 'Per provider:');
    for (const [id, summary] of Object.entries<any>(data.providers)) {
      lines.push(`  ${id}  ${summary?.error ? `error: ${summary.error}` : `created ${summary?.created ?? 0}, skipped ${summary?.skipped ?? 0}, retired ${summary?.retired ?? 0}, reinstated ${summary?.reinstated ?? 0}`}`);
    }
  }
  if ((data.created?.length ?? 0) === 0 && (data.retired?.length ?? 0) === 0) {
    lines.push('', 'Cards from a sync are unvalidated. Run `almyty models validate <id>` to make one selectable.');
  }
  return lines.join('\n');
}

function listQuery(flags: ParsedArgs['flags']): string {
  const params = new URLSearchParams();
  if (flags.selectable) params.set('selectable', 'true');
  if (str(flags, 'status')) params.set('status', str(flags, 'status')!);
  if (str(flags, 'tier')) params.set('privacyTier', str(flags, 'tier')!);
  if (str(flags, 'provider')) params.set('providerId', str(flags, 'provider')!);
  const q = params.toString();
  return q ? `?${q}` : '';
}

/**
 * Reading stdin when stdin is the terminal means waiting for a person to
 * type JSON and press ctrl-D, which looks exactly like a hang. Say so.
 */
export function assertStdinIsPiped(flag: string): void {
  if (!process.stdin.isTTY) return;
  throw new UsageError(
    `${flag} reads stdin, and stdin is your terminal, so it would wait forever.\n` +
    `  Pipe it in:  cat config.json | almyty models deploy ... ${flag}`,
  );
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function askHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const anyRl = rl as any;
    anyRl._writeToOutput = (s: string) => {
      if (s.includes(label)) anyRl.output.write(label);
    };
    rl.question(label, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/**
 * The endpoint key, from the safest place it can come from. `--api-key` is
 * refused because argv is world-readable; `-` means stdin, which is what a
 * script should use.
 */
async function endpointApiKey(flags: ParsedArgs['flags']): Promise<string | undefined> {
  const inline = str(flags, 'api-key');
  if (inline && inline !== '-') {
    throw new UsageError(
      '--api-key puts the key in your shell history and in `ps`.\n' +
      '  Leave it off and the key is prompted without echo, or read it from stdin:\n' +
      '    --api-key-stdin            (also: --api-key -)\n' +
      '  An endpoint with no key at all: --api-key ""',
    );
  }
  if (flags['api-key-stdin'] || inline === '-') {
    assertStdinIsPiped('--api-key-stdin');
    return (await readStdin()).trim() || undefined;
  }
  // `--api-key` with no value, or an explicitly empty one: an open endpoint.
  if (flags['api-key'] === true || inline === '') return undefined;
  if (!process.stdin.isTTY) return undefined; // unattended and none supplied: an open endpoint
  const typed = await askHidden('API key for the endpoint (empty for none): ');
  return typed || undefined;
}

const CONFIG_ALTERNATIVES = [
  '--config-file <path>       read the JSON object from a file',
  '--config-stdin             read the JSON object from stdin',
  '--credential <id>          use a connection made with `almyty connections connect`',
];

/**
 * Adapter configuration, from a file or stdin. Never a secret from argv.
 *
 * `schemaKnown` is false when the adapter catalog could not be read, so
 * which fields are `x-secret` is unknown. `--config` is then refused rather
 * than sent blind: failing open here would make an unreachable catalog the
 * way to get a secret onto the command line.
 */
async function deployConfig(
  flags: ParsedArgs['flags'],
  adapterSchema: any,
  schemaKnown: boolean,
): Promise<Record<string, unknown> | undefined> {
  const file = str(flags, 'config-file');
  if (file) return parseJsonObject(readFileSync(file, 'utf8'), `--config-file ${file}`);
  if (flags['config-stdin']) {
    assertStdinIsPiped('--config-stdin');
    return parseJsonObject(await readStdin(), '--config-stdin');
  }
  const inline = json(flags, 'config');
  if (!inline) return undefined;
  if (!schemaKnown) {
    throw new UsageError(
      '--config cannot be screened: the adapter list could not be read, so which of these fields\n' +
      'are secret is unknown, and argv is in your shell history and in `ps`.\n' +
      CONFIG_ALTERNATIVES.map((a) => `  ${a}`).join('\n'),
    );
  }
  assertNoArgvSecrets(adapterSchema, inline, '--config', CONFIG_ALTERNATIVES);
  return inline;
}

function newClient(): AlmytyClient {
  const creds = resolveCredentialsOrExit();
  return new AlmytyClient(creds.url, creds.token);
}

function out(args: ParsedArgs, data: unknown, pretty: () => string): void {
  console.log(args.flags.json ? JSON.stringify(data, null, 2) : pretty());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.version) {
    console.log(VERSION);
    return;
  }
  if (!args.command || args.command === 'help' || args.flags.help) {
    printHelp();
    return;
  }
  const client = newClient();
  const q = (path: string, init?: RequestInit) => client.request(path, init);
  const post = (path: string, body: unknown) => q(path, { method: 'POST', body: JSON.stringify(body) });

  switch (args.command) {
    case 'list': {
      const res = await q(`/models${listQuery(args.flags)}`);
      out(args, res.data, () => (res.data.length
        ? res.data.map(formatCard).join('\n')
        : args.flags.selectable
          ? 'No selectable model cards. A card becomes selectable when one validation run passes: almyty models validate <id>'
          : 'No model cards yet. Register one (almyty models register) or import a provider\'s list (almyty models sync).'));
      return;
    }
    case 'get': {
      const id = needArg(args.positional, 0, 'card id', 'get <id>');
      const res = await q(`/models/${id}`);
      out(args, res.data, () => formatCardDetail(res.data));
      return;
    }
    case 'route': {
      const policy = routePolicy(args.flags);
      const res = await post('/models/route-preview', policy);
      out(args, res.data, () => formatRoutePlan(res.data));
      // No candidate means nothing would answer a call under this policy.
      if (!res.data?.candidates?.length) process.exitCode = EXIT.FAILED;
      return;
    }
    case 'register': {
      const res = await post('/models', registerBody(args.flags));
      out(args, res.data, () => `Registered.\n${formatCard(res.data)}\nRun: almyty models validate ${res.data.id}`);
      return;
    }
    case 'register-endpoint': {
      const apiKey = await endpointApiKey(args.flags);
      const res = await post('/models/register-endpoint', registerEndpointBody(args.flags, apiKey));
      out(args, res.data, () => `Registered.\n${formatCard(res.data)}\nRun: almyty models validate ${res.data.id}`);
      return;
    }
    case 'set': {
      const id = needArg(args.positional, 0, 'card id', 'set <id> [--tier t] [--price-in n --price-out n] ...');
      const res = await q(`/models/${id}`, { method: 'PATCH', body: JSON.stringify(setBody(args.flags)) });
      out(args, res.data, () => `Updated.\n${formatCardDetail(res.data)}`);
      return;
    }
    case 'sync': {
      const providerId = args.positional[0];
      const res = await post('/models/sync', providerId ? { providerId } : {});
      out(args, res.data, () => formatSync(res.data));
      return;
    }
    case 'validate': {
      const id = needArg(args.positional, 0, 'card id', 'validate <id>');
      const res = await post(`/models/${id}/validate`, {});
      out(args, res.data, () => (res.data.passed
        ? `Passed in ${res.data.latencyMs} ms. The card is selectable now.\n${formatCard(res.data.model)}`
        : `Failed: ${res.data.error}\nThe card stays unselectable until a run passes.`));
      if (!res.data.passed) process.exitCode = EXIT.FAILED;
      return;
    }
    case 'delete': {
      const id = needArg(args.positional, 0, 'card id', 'delete <id>');
      const res = await q(`/models/${id}`, { method: 'DELETE' });
      out(args, res?.data ?? { id, deleted: true }, () => 'Deleted.');
      return;
    }
    case 'versions': {
      const res = await q('/model-versions');
      out(args, res.data, () => (res.data.length ? res.data.map(formatVersion).join('\n') : 'No versions registered. Registering one is optional: it buys lineage and evaluation history on your own artifact.'));
      return;
    }
    case 'register-version': {
      const res = await post('/model-versions', registerVersionBody(args.flags));
      out(args, res.data, () => `Registered.\n${formatVersion(res.data)}`);
      return;
    }
    case 'adapters': {
      const res = await q('/model-adapters');
      out(args, res.data, () => (res.data.length ? res.data.map(formatAdapter).join('\n') : 'No adapters registered.'));
      return;
    }
    case 'deploy': {
      // The adapter's schema says which config fields are secret, so the
      // check happens before anything is sent.
      const adapterKey = need(args.flags, 'adapter');
      let adapterSchema: any;
      let schemaKnown = false;
      try {
        const adapters = await q('/model-adapters');
        const adapter = adapters.data?.find((a: any) => a.key === adapterKey);
        if (!adapter) {
          throw new UsageError(
            `no adapter named ${adapterKey}. Registered: ${(adapters.data ?? []).map((a: any) => a.key).join(', ') || 'none'}`,
          );
        }
        adapterSchema = adapter.configSchema;
        schemaKnown = true;
      } catch (err) {
        if (err instanceof UsageError) throw err;
        // The catalog could not be read. The API still validates the body,
        // but --config can no longer be screened, so deployConfig refuses it.
      }
      const providerConfig = await deployConfig(args.flags, adapterSchema, schemaKnown);
      const res = await post('/model-deployments', deployBody(args.flags, args.positional, providerConfig));
      out(args, res.data, () => `Queued. Reconcile picks it up within a couple of minutes.\n${formatDeployment(res.data)}`);
      return;
    }
    case 'deployments': {
      const res = await q('/model-deployments');
      out(args, res.data, () => (res.data.length ? res.data.map(formatDeployment).join('\n') : 'No deployments.'));
      return;
    }
    case 'deployment': {
      const id = needArg(args.positional, 0, 'deployment id', 'deployment <id>');
      const res = await q(`/model-deployments/${id}`);
      out(args, res.data, () => formatDeploymentDetail(res.data));
      return;
    }
    case 'scale': {
      const id = needArg(args.positional, 0, 'deployment id', 'scale <deploymentId> <replicas>');
      const raw = needArg(args.positional, 1, 'replica count', 'scale <deploymentId> <replicas>');
      const replicas = Number(raw);
      if (!Number.isInteger(replicas) || replicas < 0) throw new UsageError(`replicas must be a whole number of zero or more, got ${raw}`);
      const res = await post(`/model-deployments/${id}/scale`, { replicas });
      out(args, res.data, () => formatDeployment(res.data));
      return;
    }
    case 'teardown': {
      const id = needArg(args.positional, 0, 'deployment id', 'teardown <deploymentId>');
      const res = await post(`/model-deployments/${id}/teardown`, {});
      out(args, res.data, () => formatDeployment(res.data));
      return;
    }
    default:
      console.error(`Unknown command: ${args.command}\n`);
      printHelp();
      process.exit(EXIT.USAGE);
  }
}

const invokedDirectly = process.argv[1] && /models-cli|almyty-models|dist\/index\.js|src\/index\.ts/.test(process.argv[1]) && !process.env.VITEST;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(describeError(err, process.env.ALMYTY_URL));
    process.exit(exitCodeFor(err));
  });
}
