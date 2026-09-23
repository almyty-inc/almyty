import { Inject, Injectable, Optional } from '@nestjs/common';

/**
 * Pins a Hugging Face reference to the commit it names right now.
 *
 * People name a model the way the Hub shows it, `org/repo`, sometimes with
 * a branch or a tag. A deployment has to point at bytes that do not move
 * under it, so before anything else reads the reference the repository is
 * asked which commit that name resolves to, and the reference carries the
 * 40-hex sha from then on. A reference that already carries a commit sha
 * is left alone and costs no network call.
 *
 * Only hf:// is resolved here. s3://, gs:// and file:// carry their own
 * explicit pin, and a provider reference is versioned by its platform.
 */

export type HubFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

/** Overridable in tests; the default is the global fetch. */
export const HF_HUB_FETCH = Symbol('HF_HUB_FETCH');

const HUB_API = 'https://huggingface.co/api/models';
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const HF_REFERENCE = /^hf:\/\/([\w.-]+\/[\w.-]+)(?:@([^@\s]+))?$/;
export const HF_RESOLVE_TIMEOUT_MS = 10_000;

export interface HfPinRequest {
  /** org/repo */
  repository: string;
  /** What was asked for: a branch, a tag, or `main` when nothing was named. */
  revision: string;
}

export class ModelSourceUnresolvedError extends Error {
  readonly code = 'MODEL_SOURCE_UNRESOLVED';
  constructor(message: string) {
    super(message);
    this.name = 'ModelSourceUnresolvedError';
  }
}

/**
 * The part of a reference that still needs a pin, or null when there is
 * nothing to resolve: not hf://, already a commit sha, or not a shape the
 * Hub could answer for (the parser refuses those with its own message).
 */
export function hfPinRequest(reference: string): HfPinRequest | null {
  const m = (reference ?? '').trim().match(HF_REFERENCE);
  if (!m) return null;
  const [, repository, revision] = m;
  if (revision && COMMIT_SHA.test(revision)) return null;
  return { repository, revision: revision || 'main' };
}

@Injectable()
export class HfRevisionResolver {
  private readonly fetchImpl: HubFetch;

  constructor(@Optional() @Inject(HF_HUB_FETCH) fetchImpl?: HubFetch) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init) as any);
  }

  /**
   * `hf://org/repo` or `hf://org/repo@<branch or tag>` in, `hf://org/repo@<sha>`
   * out. Anything else comes back unchanged without a call. Throws
   * ModelSourceUnresolvedError when the Hub does not know the name or
   * cannot be reached.
   */
  async pin(reference: string, token?: string): Promise<string> {
    const request = hfPinRequest(reference);
    if (!request) return reference;
    const sha = await this.commitFor(request, token);
    return `hf://${request.repository}@${sha}`;
  }

  private async commitFor(request: HfPinRequest, token?: string): Promise<string> {
    const url = `${HUB_API}/${request.repository}/revision/${encodeURIComponent(request.revision)}`;
    // identity: inside the running server the Hub's compressed body reached
    // res.json() undecoded (verified against a live Hub), so the pin always
    // failed with "did not return a commit". The answer is a few KB.
    const headers: Record<string, string> = { Accept: 'application/json', 'Accept-Encoding': 'identity' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const what = request.revision === 'main' ? request.repository : `${request.repository} (${request.revision})`;
    let res: Awaited<ReturnType<HubFetch>>;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(HF_RESOLVE_TIMEOUT_MS) });
    } catch (err: any) {
      const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'the Hub did not answer in time' : (err?.message ?? String(err));
      throw new ModelSourceUnresolvedError(`Could not find ${what} on Hugging Face: ${reason}`);
    }
    if (!res.ok) {
      // The Hub answers 401 as well as 404 for a repository it will not
      // show this caller, so both read as "not found" with a hint.
      const reason =
        res.status === 404 || res.status === 401 || res.status === 403
          ? `no such repository or revision, or it is private and no Hugging Face token with access to it is connected (HTTP ${res.status})`
          : `the Hub answered HTTP ${res.status}`;
      throw new ModelSourceUnresolvedError(`Could not find ${what} on Hugging Face: ${reason}`);
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const sha = typeof body?.sha === 'string' ? body.sha : '';
    if (!COMMIT_SHA.test(sha)) {
      throw new ModelSourceUnresolvedError(`Could not find ${what} on Hugging Face: the Hub did not return a commit for it`);
    }
    return sha.toLowerCase();
  }
}
