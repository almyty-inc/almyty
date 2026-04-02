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
