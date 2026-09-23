import { ParsedRegistryUri, ProviderScheme, RegistryScheme, parseRegistryUri } from '../model-registry/registry-uri';
import { AdapterCapabilities, RegistrySource } from './adapters/adapter.interface';

/**
 * Where a model is decides who can run it, and the two do not mix freely.
 *
 * Bedrock imports from S3 and cannot take a Hugging Face repository.
 * Fireworks reads a bucket with the customer's own role and cannot take a
 * Hub repo either. Hugging Face Endpoints serves a Hub repository and
 * nothing else. Vertex wants Cloud Storage or its own Model Garden. A
 * customer should learn that when choosing, not from a provider error
 * halfway through a deployment, so the rule lives here and the adapter
 * list carries it to the UI.
 */

/** A provider reference is only ever runnable by the provider it names. */
const PROVIDER_SCHEME_ADAPTERS: Record<ProviderScheme, string[]> = {
  bedrock: ['aws-bedrock-import'],
  sagemaker: ['sagemaker'],
  vertex: ['vertex'],
  foundry: ['azure-foundry'],
  azureml: ['azure-foundry'],
  fireworks: ['fireworks'],
  together: ['together'],
  baseten: ['baseten'],
};

/** Artifact schemes map onto the capability an adapter declares. */
const ARTIFACT_SOURCE: Record<string, RegistrySource> = {
  hf: 'hub',
  s3: 's3',
  gs: 'gcs',
  file: 'local',
};

export interface ModelSource {
  raw: string;
  parsed: ParsedRegistryUri;
  /** The capability an adapter must declare, for an artifact. */
  requires?: RegistrySource;
}

export function readModelSource(raw: string): ModelSource {
  const parsed = parseRegistryUri(raw);
  return { raw, parsed, requires: parsed.kind === 'artifact' ? ARTIFACT_SOURCE[parsed.scheme] : undefined };
}

/** Whether this adapter can run a model from this source, and why not when it cannot. */
export function canRun(adapterKey: string, caps: AdapterCapabilities, source: ModelSource): { ok: true } | { ok: false; reason: string } {
  if (source.parsed.kind === 'provider') {
    const allowed = PROVIDER_SCHEME_ADAPTERS[source.parsed.scheme as ProviderScheme] ?? [];
    if (allowed.includes(adapterKey)) return { ok: true };
    return {
      ok: false,
      reason: `${source.parsed.scheme}:// names a model on ${allowed[0] ?? 'another provider'}, which only that provider can run`,
    };
  }
  const required = source.requires;
  if (required && caps.registrySources.includes(required)) return { ok: true };
  return {
    ok: false,
    reason: `this provider reads ${caps.registrySources.join(', ')}, and ${source.parsed.scheme}:// is ${required ?? 'not a source it accepts'}`,
  };
}

/** Every scheme an adapter can run, for the adapter listing the forms read. */
export function schemesFor(adapterKey: string, caps: AdapterCapabilities): RegistryScheme[] {
  const artifacts = Object.entries(ARTIFACT_SOURCE)
    .filter(([, source]) => caps.registrySources.includes(source))
    .map(([scheme]) => scheme as RegistryScheme);
  const provider = (Object.entries(PROVIDER_SCHEME_ADAPTERS) as Array<[ProviderScheme, string[]]>)
    .filter(([, keys]) => keys.includes(adapterKey))
    .map(([scheme]) => scheme as RegistryScheme);
  return [...artifacts, ...provider];
}

function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The id a served endpoint answers to, for a card made from a deployment.
 *
 * vLLM and TGI serve a Hugging Face repository under its `org/repo`, and a
 * provider reference names the model the platform knows (a Bedrock ARN,
 * `accounts/x/models/y` on Fireworks), so both keep the whole location.
 * An object-store or file artifact is served under its directory name.
 */
export function defaultVendorModelId(source: ModelSource): string {
  const { parsed } = source;
  if (parsed.scheme === 'hf' || parsed.kind === 'provider') return parsed.location;
  if (parsed.scheme === 's3' || parsed.scheme === 'gs') return parsed.prefix ? lastSegment(parsed.prefix) : parsed.location;
  return lastSegment(parsed.location);
}

/** A readable card name: `Llama-3.1-8B-Instruct` for hf://meta-llama/Llama-3.1-8B-Instruct@abc. */
export function defaultCardName(source: ModelSource): string {
  const { parsed } = source;
  if (parsed.kind === 'provider') return lastSegment(stripPin(parsed.location)).slice(0, 255);
  return lastSegment(defaultVendorModelId(source)).slice(0, 255);
}

/** A provider reference may carry its own `@version`; the served id does not. */
function stripPin(location: string): string {
  const at = location.lastIndexOf('@');
  return at > 0 && !location.slice(at + 1).includes('/') ? location.slice(0, at) : location;
}
