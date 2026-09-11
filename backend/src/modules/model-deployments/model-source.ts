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
