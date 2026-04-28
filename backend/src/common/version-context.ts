import { AsyncLocalStorage } from 'async_hooks';

export interface VersionContextStore {
  userId?: string;
  userEmail?: string;
  /**
   * Bulk-import override. When true, CustomVersionSubscriber skips
   * persisting per-row version diffs entirely. Used by schema
   * imports that may create 600+ entities in one go — the diff
   * machinery materialises a full JSON copy of every entity in
   * memory before flush, which on a Stripe-class import added
   * 200-400 MB to peak heap. Per-row history isn't useful for
   * fresh-imported entities anyway; the import itself is the
   * single audit event.
   */
  skipVersions?: boolean;
}

export const versionContext = new AsyncLocalStorage<VersionContextStore>();

export function getVersionOwner(): string {
  const ctx = versionContext.getStore();
  return ctx?.userEmail || ctx?.userId || 'system';
}

export function shouldSkipVersions(): boolean {
  return versionContext.getStore()?.skipVersions === true;
}
