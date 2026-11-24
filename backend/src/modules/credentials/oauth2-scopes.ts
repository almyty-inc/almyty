/**
 * Scope arithmetic for one OAuth 2.0 sign-in shared by several APIs of the
 * same provider (one Google sign-in for Calendar, Gmail and Tasks).
 *
 * Scopes are compared as exact strings and never rewritten: a sign-in that
 * holds gmail.readonly does not cover gmail.modify, and adding an API that
 * asks for gmail.readonly never asks for more than that. The union is only
 * of what was already granted and what each API asked for.
 */

/** Split a token endpoint's `scope` answer ("a b c", sometimes comma-separated). */
export function parseScopeString(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(/[\s,]+/).filter(Boolean);
}

/** `a` then whatever of `b` is not in it, each scope once, in order. */
export function scopeUnion(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const s of [...(a ?? []), ...(b ?? [])]) {
    if (typeof s === 'string' && s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The scopes of `requested` that `granted` does not hold. */
export function missingScopes(granted: readonly string[] | null | undefined, requested: readonly string[] | null | undefined): string[] {
  const have = new Set(granted ?? []);
  return scopeUnion([], requested).filter((s) => !have.has(s));
}

/** The scopes a sign-in holds: what the provider said it granted, else what was asked for. */
export function grantedScopesOf(credential: { scopesGranted?: string[] | null; scopes?: string[] | null }): string[] {
  if (Array.isArray(credential.scopesGranted) && credential.scopesGranted.length > 0) return [...credential.scopesGranted];
  return Array.isArray(credential.scopes) ? [...credential.scopes] : [];
}

/** Host of a URL, or null. Two sign-ins are of the same provider when their token endpoints share a host. */
export function hostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
