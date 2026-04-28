import { AsyncLocalStorage } from 'async_hooks';

export interface VersionContextStore {
  userId?: string;
  userEmail?: string;
}

export const versionContext = new AsyncLocalStorage<VersionContextStore>();

export function getVersionOwner(): string {
  const ctx = versionContext.getStore();
  return ctx?.userEmail || ctx?.userId || 'system';
}

// Per-save versioning skip is now provided upstream by typeorm-versions
// (>=0.6.0) — use saveWithoutVersioning(target, entity, options?) at
// the call site instead of an AsyncLocalStorage flag. The subscriber
// reads event.queryRunner?.data?.skipVersioning, which is set
// transactionally by the upstream helper for the duration of the save.
