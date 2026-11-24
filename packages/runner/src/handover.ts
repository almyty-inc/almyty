/**
 * How a hosted pod hands the runner its own tokens: as files in a
 * memory-backed folder (ALMYTY_HANDOVER_DIR), which the runner deletes once
 * read.
 *
 * Not as variables: a variable a process starts with stays readable in
 * /proc/<pid>/environ for the life of that process, whatever it later
 * deletes from its own environment, and every command an agent runs on the
 * machine runs as the same user as the runner (and as tini, PID 1). A file
 * deleted once read is gone for everything started after.
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const HANDOVER_DIR_ENV = 'ALMYTY_HANDOVER_DIR';

export interface HandoverFs {
  readFile: (path: string) => string;
  unlink: (path: string) => void;
}

const realFs: HandoverFs = {
  readFile: (p) => readFileSync(p, 'utf-8'),
  unlink: (p) => unlinkSync(p),
};

/**
 * The handed-over file `name`, trimmed, deleted as it is read; null when
 * the pod hands nothing over or not this file. Any other failure to read
 * it, or to delete it, throws: a token that stays on disk is not taken.
 */
export function takeHandoverFile(env: Record<string, string | undefined>, name: string, fs: HandoverFs = realFs): string | null {
  const dir = (env[HANDOVER_DIR_ENV] ?? '').trim();
  if (!dir) return null;
  const path = join(dir, name);
  let value: string;
  try {
    value = fs.readFile(path);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw new Error(`cannot read ${path}: ${err?.code ?? err?.message ?? err}`);
  }
  try {
    fs.unlink(path);
  } catch (err: any) {
    throw new Error(`cannot delete ${path} after reading it: ${err?.code ?? err?.message ?? err}`);
  }
  return value.trim();
}
