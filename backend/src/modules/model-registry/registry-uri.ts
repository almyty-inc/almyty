/**
 * What a version points at. Two kinds, because almyty does not host
 * models: it either points at artifact bytes that a provider will read,
 * or at a model that already exists on a provider.
 *
 * Artifacts, pinned so the version is immutable:
 *   hf://org/repo@sha            a Hugging Face repository, the usual case
 *   s3://bucket/prefix@etag      object storage a provider reads itself
 *   gs://bucket/prefix@gen       the same on Google Cloud Storage
 *   file:///abs/path@sha         a path on the machine that serves it
 *
 * Provider references, to a model you uploaded or trained on a platform
 * and want almyty to run. The platform owns the versioning, so no pin is
 * required and there is no manifest to read:
 *   bedrock://<model id or arn>
 *   sagemaker://model-package/<arn>
 *   vertex://publishers/<publisher>/models/<model>
 *   foundry://<format>/<name>@<version>
 *   azureml://registries/<registry>/models/<name>/labels/<label>
 *   fireworks://accounts/<account>/models/<model>
 *   together://<owner>/<model>
 *   baseten://<model id>
 */
export type ArtifactScheme = 'hf' | 's3' | 'gs' | 'file';
export type ProviderScheme = 'bedrock' | 'sagemaker' | 'vertex' | 'foundry' | 'azureml' | 'fireworks' | 'together' | 'baseten';
export type RegistryScheme = ArtifactScheme | ProviderScheme;

const ARTIFACT_SCHEMES: ArtifactScheme[] = ['hf', 's3', 'gs', 'file'];
const PROVIDER_SCHEMES: ProviderScheme[] = ['bedrock', 'sagemaker', 'vertex', 'foundry', 'azureml', 'fireworks', 'together', 'baseten'];

export interface ParsedRegistryUri {
  scheme: RegistryScheme;
  /** 'artifact' points at bytes; 'provider' names a model the platform already holds. */
  kind: 'artifact' | 'provider';
  /** bucket for s3 and gs, org/repo for hf, absolute path for file, the whole reference for a provider. */
  location: string;
  /** Key prefix for object storage; empty otherwise. */
  prefix: string;
  /** etag, sha or digest that pins the bytes. Empty for a provider reference, which the platform versions. */
  pin: string;
  raw: string;
}

export class InvalidRegistryUriError extends Error {
  readonly code = 'REGISTRY_URI_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRegistryUriError';
  }
}

const SCHEME_LIST = [...ARTIFACT_SCHEMES, ...PROVIDER_SCHEMES].join('|');

export function parseRegistryUri(raw: string): ParsedRegistryUri {
  const value = (raw ?? '').trim();
  const scheme = value.slice(0, Math.max(value.indexOf('://'), 0)) as RegistryScheme;
  if (PROVIDER_SCHEMES.includes(scheme as ProviderScheme)) {
    const body = value.slice(scheme.length + 3).trim();
    if (!body) throw new InvalidRegistryUriError(`${scheme} registryUri needs the model reference after ${scheme}://`);
    if (body.includes('..')) throw new InvalidRegistryUriError('registryUri may not contain ..');
    // The platform versions its own models, so a pin is allowed but not required.
    const at = body.lastIndexOf('@');
    const pin = at > 0 && !body.slice(at + 1).includes('/') ? body.slice(at + 1) : '';
    return { scheme, kind: 'provider', location: body, prefix: '', pin, raw: value };
  }

  const m = value.match(new RegExp(`^(${ARTIFACT_SCHEMES.join('|')}):\\/\\/(.+?)@([A-Za-z0-9._:-]+)$`));
  if (!m) {
    throw new InvalidRegistryUriError(
      `registryUri must be an artifact with a pin (hf://org/repo@sha, s3://bucket/prefix@etag, gs://bucket/prefix@generation, file:///path@sha) ` +
        `or a reference to a model already on a provider (${PROVIDER_SCHEMES.map((s) => `${s}://...`).join(', ')})`,
    );
  }
  const [, artifactScheme, body, pin] = m as [string, ArtifactScheme, string, string];
  if (body.includes('..')) throw new InvalidRegistryUriError('registryUri may not contain ..');
  if (artifactScheme === 's3' || artifactScheme === 'gs') {
    const slash = body.indexOf('/');
    const bucket = slash === -1 ? body : body.slice(0, slash);
    const prefix = slash === -1 ? '' : body.slice(slash + 1).replace(/\/+$/, '');
    if (!bucket) throw new InvalidRegistryUriError(`${artifactScheme} registryUri needs a bucket`);
    return { scheme: artifactScheme, kind: 'artifact', location: bucket, prefix, pin, raw: value };
  }
  if (artifactScheme === 'hf') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(body)) throw new InvalidRegistryUriError('hf registryUri must be hf://org/repo@sha');
    return { scheme: artifactScheme, kind: 'artifact', location: body, prefix: '', pin, raw: value };
  }
  if (!body.startsWith('/')) throw new InvalidRegistryUriError('file registryUri must be an absolute path');
  return { scheme: artifactScheme, kind: 'artifact', location: body, prefix: '', pin, raw: value };
}

/** The schemes a version may use, for error messages and forms. */
export function registrySchemes(): { artifact: ArtifactScheme[]; provider: ProviderScheme[] } {
  return { artifact: [...ARTIFACT_SCHEMES], provider: [...PROVIDER_SCHEMES] };
}
