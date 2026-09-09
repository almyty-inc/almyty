/**
 * Where a version's weights live, in one of three shapes:
 *
 *   s3://bucket/prefix@etag      the default, any S3-compatible store
 *   hf://org/repo@sha            an optional read-only source
 *   file:///abs/path@sha         runner-local
 *
 * The part after `@` pins the exact bytes; a URI without it is a moving
 * pointer and is refused for a version, which must be immutable.
 */
export type RegistryScheme = 's3' | 'hf' | 'file';

export interface ParsedRegistryUri {
  scheme: RegistryScheme;
  /** bucket for s3, org/repo for hf, absolute path for file. */
  location: string;
  /** Key prefix for s3; empty otherwise. */
  prefix: string;
  /** etag / sha / digest that pins the bytes. */
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

export function parseRegistryUri(raw: string): ParsedRegistryUri {
  const value = (raw ?? '').trim();
  const m = value.match(/^(s3|hf|file):\/\/(.+?)@([A-Za-z0-9._:-]+)$/);
  if (!m) {
    throw new InvalidRegistryUriError(
      'registryUri must look like s3://bucket/prefix@etag, hf://org/repo@sha or file:///path@sha (the @pin is required)',
    );
  }
  const [, scheme, body, pin] = m as [string, RegistryScheme, string, string];
  if (body.includes('..')) throw new InvalidRegistryUriError('registryUri may not contain ..');
  if (scheme === 's3') {
    const slash = body.indexOf('/');
    const bucket = slash === -1 ? body : body.slice(0, slash);
    const prefix = slash === -1 ? '' : body.slice(slash + 1).replace(/\/+$/, '');
    if (!bucket) throw new InvalidRegistryUriError('s3 registryUri needs a bucket');
    return { scheme, location: bucket, prefix, pin, raw: value };
  }
  if (scheme === 'hf') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(body)) throw new InvalidRegistryUriError('hf registryUri must be hf://org/repo@sha');
    return { scheme, location: body, prefix: '', pin, raw: value };
  }
  if (!body.startsWith('/')) throw new InvalidRegistryUriError('file registryUri must be an absolute path');
  return { scheme, location: body, prefix: '', pin, raw: value };
}
