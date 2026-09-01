import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Where the API image drops @almyty/chat so bun can compile it.
 * Not a Node dependency of the backend: the processor only hands
 * this path to bun.
 */
export const IMAGE_CLIENT_ENTRY =
  '/opt/almyty/node_modules/@almyty/chat/dist/index.js';

/**
 * Where the terminal client lives on this host.
 *
 * Explicit configuration first, then the monorepo layout, then the
 * path the API image uses, then a normal package resolution.
 * Returns null rather than throwing so a build fails with a sentence
 * naming the fix instead of a stack trace about module resolution.
 */
export async function resolveClientEntry(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string | null> {
  const configured = env.APP_BUILD_CLIENT_ENTRY;
  if (configured) {
    return (await fs.stat(configured).catch(() => null)) ? configured : null;
  }

  const candidates = [
    join(cwd, '..', 'packages', 'chat-cli', 'dist', 'index.js'),
    IMAGE_CLIENT_ENTRY,
  ];
  for (const path of candidates) {
    if (await fs.stat(path).catch(() => null)) return path;
  }

  try {
    return require.resolve('@almyty/chat/dist/index.js', { paths: [cwd] });
  } catch {
    return null;
  }
}

