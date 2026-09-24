import { readFileSync } from 'fs';
import { join } from 'path';

import { EgressError, ssrfSafeDispatcher } from '../../../common/security/safe-fetch';
import { HF_MAX_REDIRECTS, hfFetch, isHuggingFaceHost } from '../hf-fetch';

/**
 * A pretend internet: each URL answers with a fixed Response, and every
 * request is recorded with the headers and options it was sent with.
 */
function internet(routes: Record<string, () => Response>) {
  const requests: Array<{ url: string; headers: Record<string, string>; init: any }> = [];
  const transport = async (url: string, init: any) => {
    requests.push({ url, headers: { ...(init.headers ?? {}) }, init });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  };
  return { transport, requests };
}

const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
const ok = (body: string) => () => new Response(body, { status: 200 });

const RESOLVE = 'https://huggingface.co/org/model/resolve/abc/almyty-manifest.json';
const TOKEN = { Authorization: 'Bearer hf_secret' };

describe('hfFetch', () => {
  it('follows the Hub to its CDN, keeping the token on huggingface.co only', async () => {
    const cdn = 'https://cdn-lfs.huggingface.co/repos/aa/bb?X-Amz-Signature=1';
    const net = internet({ [RESOLVE]: redirect(cdn), [cdn]: ok('{"schemaVersion":1}') });

    const res = await hfFetch(RESOLVE, { headers: TOKEN }, net.transport);

    expect(await res.text()).toBe('{"schemaVersion":1}');
    expect(net.requests.map((r) => r.url)).toEqual([RESOLVE, cdn]);
    expect(net.requests[0].headers.Authorization).toBe('Bearer hf_secret');
    expect(net.requests[1].headers).not.toHaveProperty('Authorization');
    // Every hop is taken by hand and connects through the pinned dispatcher.
    for (const r of net.requests) {
      expect(r.init.redirect).toBe('manual');
      expect(r.init.dispatcher).toBe(ssrfSafeDispatcher);
    }
  });

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['cloud metadata over https', 'https://169.254.169.254/latest/meta-data/'],
    ['a loopback address', 'https://127.0.0.1/'],
    ['another site', 'https://evil.example/weights'],
    ['a look-alike host', 'https://huggingface.co.evil.example/x'],
    ['a downgrade to http on an HF host', 'http://cdn-lfs.huggingface.co/x'],
  ])('refuses a redirect to %s without requesting it', async (_name, location) => {
    const net = internet({ [RESOLVE]: redirect(location) });

    await expect(hfFetch(RESOLVE, { headers: TOKEN }, net.transport)).rejects.toBeInstanceOf(EgressError);
    expect(net.requests.map((r) => r.url)).toEqual([RESOLVE]);
  });

  it('resolves a relative Location against the hop it came from', async () => {
    const moved = 'https://huggingface.co/new-org/model/resolve/abc/almyty-manifest.json';
    const net = internet({ [RESOLVE]: redirect('/new-org/model/resolve/abc/almyty-manifest.json', 307), [moved]: ok('x') });

    await hfFetch(RESOLVE, {}, net.transport);
    expect(net.requests.map((r) => r.url)).toEqual([RESOLVE, moved]);
  });

  it('stops a redirect loop', async () => {
    const a = 'https://huggingface.co/a';
    const b = 'https://huggingface.co/b';
    const net = internet({ [a]: redirect(b), [b]: redirect(a) });

    await expect(hfFetch(a, {}, net.transport)).rejects.toThrow(`more than ${HF_MAX_REDIRECTS} redirects`);
    expect(net.requests).toHaveLength(HF_MAX_REDIRECTS + 1);
  });

  it('refuses a first URL that is not Hugging Face', async () => {
    const net = internet({});
    await expect(hfFetch('https://example.com/x', {}, net.transport)).rejects.toBeInstanceOf(EgressError);
    expect(net.requests).toHaveLength(0);
  });

  it('knows which hosts are Hugging Face', () => {
    for (const host of ['huggingface.co', 'cdn-lfs.huggingface.co', 'hf.co', 'cas-bridge.xethub.hf.co', 'HUGGINGFACE.CO.']) {
      expect(isHuggingFaceHost(host)).toBe(true);
    }
    for (const host of ['huggingface.com', 'nothuggingface.co', 'huggingface.co.evil.example', 'hf.com']) {
      expect(isHuggingFaceHost(host)).toBe(false);
    }
  });

  it('is the only way the model registry reaches Hugging Face', () => {
    for (const file of ['model-registry.service.ts', 'hf-revision.resolver.ts']) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      expect(source).toContain('hfFetch(');
      expect(source).not.toMatch(/[^.\w]fetch\(/);
    }
  });
});
