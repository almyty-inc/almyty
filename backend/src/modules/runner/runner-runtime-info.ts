import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { RunnerRuntimeInfoDto } from './dto/register-runner.dto';

/** Binaries one runtime report may list; the default probe list is ~25. */
const MAX_BINARIES = 256;
const MAX_VERSION_LENGTH = 255;

/**
 * Why a runtime report a runner sent over its stream cannot be stored, or
 * null when it can. The same rules as the runtimeInfo of a registration
 * (RunnerRuntimeInfoDto), plus what that DTO leaves open: `binaries` maps a
 * bounded number of names to a version string or null.
 */
export function runtimeInfoProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
  const errors = validateSync(plainToInstance(RunnerRuntimeInfoDto, raw), { forbidUnknownValues: false });
  if (errors.length) return errors.map((e) => e.property).join(', ') + ' invalid';
  const binaries = (raw as { binaries?: unknown }).binaries;
  if (!binaries || typeof binaries !== 'object' || Array.isArray(binaries)) return 'binaries invalid';
  const entries = Object.entries(binaries);
  if (entries.length > MAX_BINARIES) return `more than ${MAX_BINARIES} binaries`;
  for (const [name, version] of entries) {
    if (name.length > 120) return 'binary name too long';
    if (version !== null && (typeof version !== 'string' || version.length > MAX_VERSION_LENGTH)) return `binaries.${name} invalid`;
  }
  return null;
}
