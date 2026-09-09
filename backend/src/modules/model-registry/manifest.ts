import { createHash } from 'crypto';

/**
 * almyty-manifest.json: the file that makes a version portable between
 * adapters. It sits next to the safetensors in the registry and says
 * what the weights are, not where they run.
 */
export interface ModelManifest {
  schemaVersion: 1;
  /** Base architecture family, e.g. qwen3-14b. */
  base: string;
  /** Where the tokenizer comes from: a registry URI or a hub id. */
  tokenizer: string;
  /** Jinja chat template, or the name of a well-known one. */
  chatTemplate?: string;
  /** SPDX id or a URL. */
  license: string;
  /** ISO timestamp. */
  created: string;
  /** Weight files relative to the manifest, with sizes so a partial copy is detectable. */
  files: Array<{ path: string; sizeBytes: number; sha256?: string }>;
  quantizations?: string[];
  lineage?: { trainingJobId?: string; datasetRef?: string; parentVersionId?: string };
}

export class InvalidManifestError extends Error {
  readonly code = 'REGISTRY_MANIFEST_INVALID';
  constructor(readonly problems: string[]) {
    super(`invalid almyty-manifest.json: ${problems.join('; ')}`);
    this.name = 'InvalidManifestError';
  }
}

const REQUIRED: Array<keyof ModelManifest> = ['schemaVersion', 'base', 'tokenizer', 'license', 'created', 'files'];

export function validateManifest(input: unknown): ModelManifest {
  const problems: string[] = [];
  if (!input || typeof input !== 'object') throw new InvalidManifestError(['not an object']);
  const m = input as Record<string, any>;
  for (const key of REQUIRED) if (m[key] === undefined || m[key] === null) problems.push(`missing ${key}`);
  if (m.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (typeof m.base !== 'string' || !m.base) problems.push('base must be a non-empty string');
  if (typeof m.tokenizer !== 'string' || !m.tokenizer) problems.push('tokenizer must be a non-empty string');
  if (typeof m.license !== 'string' || !m.license) problems.push('license must be a non-empty string');
  if (typeof m.created !== 'string' || Number.isNaN(Date.parse(m.created))) problems.push('created must be an ISO timestamp');
  if (!Array.isArray(m.files) || m.files.length === 0) problems.push('files must list at least one weight file');
  else {
    m.files.forEach((f: any, i: number) => {
      if (!f || typeof f.path !== 'string' || !f.path) problems.push(`files[${i}].path missing`);
      else if (f.path.startsWith('/') || f.path.includes('..')) problems.push(`files[${i}].path must be relative and may not contain ..`);
      if (typeof f.sizeBytes !== 'number' || f.sizeBytes < 0) problems.push(`files[${i}].sizeBytes must be a non-negative number`);
    });
  }
  if (m.quantizations !== undefined && !Array.isArray(m.quantizations)) problems.push('quantizations must be an array');
  if (problems.length) throw new InvalidManifestError(problems);
  return m as ModelManifest;
}

/** Stable digest of the manifest, recorded on the version as manifestSha. */
export function manifestSha(manifest: ModelManifest): string {
  const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

export function totalSizeBytes(manifest: ModelManifest): number {
  return manifest.files.reduce((n, f) => n + (f.sizeBytes || 0), 0);
}
