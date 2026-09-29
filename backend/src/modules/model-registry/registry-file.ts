import { promises as fs } from 'fs';
import { join, sep } from 'path';

/**
 * Reading a file:// registry URI on this server.
 *
 * A file:// version names a path on the host that serves the model (an
 * Ollama box, a runner), which is why registering one reads nothing by
 * default: a path an organization admin types is not a path the API
 * process should open. It used to open it, whatever it was, and report
 * back whether a manifest was there: any directory on the API host, any
 * mounted secret volume, any other tenant's upload directory.
 *
 * An operator who does keep manifests on this machine names the one
 * directory they live under in MODEL_REGISTRY_FILE_ROOT. The real path of
 * what is read (symlinks followed) must be inside the real path of that
 * root, it must be a regular file, and it must be manifest-sized.
 */
export const REGISTRY_FILE_ROOT_ENV = 'MODEL_REGISTRY_FILE_ROOT';

/** A manifest lists files; one this large is not one. */
export const MAX_REGISTRY_FILE_BYTES = 1024 * 1024;

export class RegistryFileRefusedError extends Error {
  readonly code = 'REGISTRY_FILE_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'RegistryFileRefusedError';
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

export async function readRegistryFile(
  location: string,
  file: string,
  root: string | undefined = process.env[REGISTRY_FILE_ROOT_ENV],
): Promise<string> {
  if (!root?.trim()) {
    throw new RegistryFileRefusedError(
      `file:// paths name a path on the host that serves the model; this server reads none unless ${REGISTRY_FILE_ROOT_ENV} is set`,
    );
  }
  const realRoot = await fs.realpath(root.trim());
  const target = await fs.realpath(join(location, file)).catch(() => {
    throw new RegistryFileRefusedError(`no ${file} under ${location}`);
  });
  if (!inside(realRoot, target)) {
    throw new RegistryFileRefusedError(`${location} is outside ${REGISTRY_FILE_ROOT_ENV}`);
  }
  // Checked before opening as well as after: opening a FIFO blocks.
  const check = (stat: { isFile(): boolean; size: number }) => {
    if (!stat.isFile()) throw new RegistryFileRefusedError(`${file} under ${location} is not a file`);
    if (stat.size > MAX_REGISTRY_FILE_BYTES) {
      throw new RegistryFileRefusedError(`${file} under ${location} is larger than a manifest`);
    }
  };
  check(await fs.stat(target));
  const handle = await fs.open(target, 'r');
  try {
    check(await handle.stat());
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
