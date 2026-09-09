#!/usr/bin/env node
/**
 * @almyty/models: the model catalog from the terminal.
 *
 *   almyty models list [--selectable] [--json]
 *   almyty models get <id>
 *   almyty models register --name n --provider <providerId> --model <vendorModelId> [--tier t] [--region r]
 *   almyty models register-endpoint --name n --url <base url> --model <vendorModelId> [--api-key k] [--tier t] [--region r]
 *   almyty models sync <providerId>
 *   almyty models validate <id>
 *   almyty models adapters
 *   almyty models deploy --model-version <modelVersionId> --adapter <key> [--config json] [--desired json] [--credential id] [--budget id] [--model cardId]
 --adapter <key> [--config json] [--desired json] [--credential id] [--budget id] [--model cardId]
 *   almyty models deployments
 *   almyty models scale <deploymentId> <replicas>
 *   almyty models teardown <deploymentId>
 */
import { AlmytyClient, resolveCredentialsOrExit } from '@almyty/client';

const VERSION = '0.1.0';

export interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { positional: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.flags.version = true;
    } else if (arg === '--json' || arg === '--selectable') {
      result.flags[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result.flags[key] = next;
        i++;
      } else {
        result.flags[key] = true;
      }
    } else if (!result.command) {
      result.command = arg;
    } else {
      result.positional.push(arg);
    }
    i++;
  }
  return result;
}

function printHelp(): void {
  console.log(`
@almyty/models v${VERSION}

Usage:
  npx @almyty/models <command> [options]

Catalog:
  list [--selectable]                  List model cards (selectable = validated and callable)
  get <id>                             Show one card
  register --name n --provider id --model vendorModelId [--tier public|private_cloud|local] [--region r] [--context n]
  register-endpoint --name n --url baseUrl --model vendorModelId [--api-key k] [--tier t] [--region r]
  sync <providerId>                    Import what a stored provider lists, as unvalidated cards
  validate <id>                        Run one real call; passing makes the card selectable
  delete <id>

Versions:
  versions                             Registered model versions (weights)
  register-version --name n --uri <s3://bucket/key@etag | hf://org/repo@rev | file:///path@sha> [--base b] [--quantizations q1,q2]

Deployments:
  adapters 
                            Registered adapters, capabilities and config schema
  deploy --model-version id --adapter key [--config '<json>'] [--desired '<json>'] [--credential id] [--budget id] [--model cardId]
  deployments                          List deployments (desired vs actual, spend)
  scale <deploymentId> <replicas>
  teardown <deploymentId>

Options:
  --json                               Raw JSON output

Environment:
  ALMYTY_TOKEN                         Token override (skips ~/.almyty/credentials.json)
  ALMYTY_URL                           API URL override
`);
}

function str(flags: ParsedArgs['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function need(flags: ParsedArgs['flags'], key: string): string {
  const v = str(flags, key);
  if (!v) throw new Error(`--${key} is required`);
  return v;
}

function json(flags: ParsedArgs['flags'], key: string): Record<string, unknown> | undefined {
  const v = str(flags, key);
  if (!v) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    throw new Error(`--${key} must be valid JSON`);
  }
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
  if (str(flags, 'context')) body.contextLength = Number(str(flags, 'context'));
  return body;
}

export function registerEndpointBody(flags: ParsedArgs['flags']): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: need(flags, 'name'),
    url: need(flags, 'url'),
    vendorModelId: need(flags, 'model'),
  };
  if (str(flags, 'api-key')) body.apiKey = str(flags, 'api-key');
  if (str(flags, 'tier')) body.privacyTier = str(flags, 'tier');
  if (str(flags, 'region')) body.region = str(flags, 'region');
  return body;
}

export function deployBody(flags: ParsedArgs['flags']): Record<string, unknown> {
  const body: Record<string, unknown> = {
    modelVersionId: need(flags, 'model-version'),

    providerType: need(flags, 'adapter'),
  };
  const providerConfig = json(flags, 'config');
  const desired = json(flags, 'desired');
  if (providerConfig) body.providerConfig = providerConfig;
  if (desired) body.desired = desired;
  if (str(flags, 'credential')) body.credentialId = str(flags, 'credential');
  if (str(flags, 'budget')) body.budgetId = str(flags, 'budget');
  if (str(flags, 'model')) body.modelId = str(flags, 'model');
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

export function formatCard(c: any): string {

  const price = c.effectivePricing ? `$${c.effectivePricing.inPerMTok}/$${c.effectivePricing.outPerMTok} per M (${c.pricingSource})` : 'unpriced';
  const flag = c.selectable ? 'selectable' : `not selectable (validation: ${c.validationStatus}${c.lastValidationError ? `: ${c.lastValidationError}` : ''})`;
  return `${c.name}  [${c.vendorModelId}]  ${c.privacyTier}${c.region ? `/${c.region}` : ''}  ${price}\n    ${c.id}  ${flag}`;
}

export function formatDeployment(d: any): string {
  const spend = d.actual?.spentCents != null ? `  spent ${(d.actual.spentCents / 100).toFixed(2)} USD` : '';
  return `${d.id}  ${d.providerType}  ${d.state}  replicas ${d.actual?.replicas ?? '?'}/${d.desired?.replicas ?? '?'}${spend}${d.lastError ? `\n    ${d.lastError}` : ''}`;
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
      const res = await q(`/models${args.flags.selectable ? '?selectable=true' : ''}`);
      out(args, res.data, () => (res.data.length ? res.data.map(formatCard).join('\n') : 'No model cards yet. Register one or sync a provider.'));
      return;
    }
    case 'get': {
      const res = await q(`/models/${args.positional[0]}`);
      out(args, res.data, () => formatCard(res.data));
      return;
    }
    case 'register': {
      const res = await post('/models', registerBody(args.flags));
      out(args, res.data, () => `Registered.\n${formatCard(res.data)}\nRun: almyty models validate ${res.data.id}`);
      return;
    }
    case 'register-endpoint': {
      const res = await post('/models/register-endpoint', registerEndpointBody(args.flags));
      out(args, res.data, () => `Registered.\n${formatCard(res.data)}\nRun: almyty models validate ${res.data.id}`);
      return;
    }
    case 'sync': {
      const res = await post('/models/sync', { providerId: args.positional[0] });
      out(args, res.data, () => `${res.data.created.length} card(s) created, ${res.data.skipped} already present.`);
      return;
    }
    case 'validate': {
      const res = await post(`/models/${args.positional[0]}/validate`, {});
      out(args, res.data, () => (res.data.passed ? `Passed in ${res.data.latencyMs} ms.\n${formatCard(res.data.model)}` : `Failed: ${res.data.error}`));
      if (!res.data.passed) process.exitCode = 1;
      return;
    }
    case 'delete': {
      await q(`/models/${args.positional[0]}`, { method: 'DELETE' });
      console.log('Deleted.');
      return;
    }
    case 'versions': {
      const res = await q('/model-versions');
      out(args, res.data, () => (res.data.length ? res.data.map(formatVersion).join('\n') : 'No versions registered.'));
      return;
    }
    case 'register-version': {
      const res = await post('/model-versions', registerVersionBody(args.flags));
      out(args, res.data, () => `Registered.\n${formatVersion(res.data)}`);
      return;
    }
    case 'adapters': {

      const res = await q('/model-adapters');
      out(args, res.data, () => res.data.map((a: any) => `${a.key}  ${a.displayName}\n    ${Object.entries(a.capabilities).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`).join('\n'));
      return;
    }
    case 'deploy': {
      const res = await post('/model-deployments', deployBody(args.flags));
      out(args, res.data, () => `Queued.\n${formatDeployment(res.data)}`);
      return;
    }
    case 'deployments': {
      const res = await q('/model-deployments');
      out(args, res.data, () => (res.data.length ? res.data.map(formatDeployment).join('\n') : 'No deployments.'));
      return;
    }
    case 'scale': {
      const res = await post(`/model-deployments/${args.positional[0]}/scale`, { replicas: Number(args.positional[1]) });
      out(args, res.data, () => formatDeployment(res.data));
      return;
    }
    case 'teardown': {
      const res = await post(`/model-deployments/${args.positional[0]}/teardown`, {});
      out(args, res.data, () => formatDeployment(res.data));
      return;
    }
    default:
      console.error(`Unknown command: ${args.command}\n`);
      printHelp();
      process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && /models-cli|almyty-models|dist\/index\.js|src\/index\.ts/.test(process.argv[1]) && !process.env.VITEST;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
