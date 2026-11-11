// The pinned API descriptions: downloaded once from a commit-pinned URL into
// a cache directory, checked against the recorded SHA-256, and (for a
// subset) cut down deterministically.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { countOperations, subsetByTag } from './subset.mjs';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The upstream bytes of a spec, from the cache or the network, checksum-verified. */
export async function fetchPinned(spec, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${spec.id}.upstream`);
  let buf = existsSync(file) ? readFileSync(file) : null;
  if (!buf || sha256(buf) !== spec.sha256) {
    const res = await fetch(spec.url);
    if (!res.ok) throw new Error(`download of ${spec.url} answered ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(file, buf);
  }
  const got = sha256(buf);
  if (got !== spec.sha256) throw new Error(`${spec.id}: checksum ${got} does not match the pinned ${spec.sha256}`);
  return buf;
}

/**
 * What is imported: the upstream bytes as they are, or the tag subset as
 * compact JSON. Returns the content, its checksum and its operation count
 * (read from the description, before almyty sees it).
 */
export async function loadSpec(spec, cacheDir) {
  const upstream = await fetchPinned(spec, cacheDir);
  let content = upstream;
  let operations = null;
  if (spec.subset?.tag) {
    const cut = subsetByTag(JSON.parse(upstream.toString('utf8')), spec.subset.tag);
    content = Buffer.from(JSON.stringify(cut));
    operations = countOperations(cut);
    if (spec.subset.sha256 && sha256(content) !== spec.subset.sha256) {
      throw new Error(`${spec.id}: the ${spec.subset.tag} subset came out as ${sha256(content)}, not the pinned ${spec.subset.sha256}`);
    }
  } else {
    const text = upstream.toString('utf8');
    operations = countOperations(spec.fileName.endsWith('.json') ? JSON.parse(text) : parseYaml(text));
  }
  return { content, bytes: content.length, sha256: sha256(content), operations };
}
