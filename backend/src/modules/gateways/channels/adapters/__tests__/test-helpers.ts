/**
 * Shared helpers for channel adapter unit tests.
 *
 * Adapters call `globalThis.fetch || (await import('node-fetch')).default`
 * — so every test that exercises sendResponse swaps in a mock on
 * globalThis.fetch and inspects what was sent. The helper below also
 * strips the singleton at the end of each test so the mock doesn't leak
 * across files.
 */

export interface CapturedFetch {
  url: string;
  init: any;
}

/** Install a jest mock fetch. Call captures into the returned array. */
export function installFetchMock(): {
  calls: CapturedFetch[];
  setNextResponse: (response: Partial<{ ok: boolean; status: number; json: any; text: string }>) => void;
  restore: () => void;
} {
  const original = (globalThis as any).fetch;
  const calls: CapturedFetch[] = [];
  let nextResponse = { ok: true, status: 200, json: {}, text: '' };
  const mock = jest.fn(async (url: string, init?: any) => {
    calls.push({ url, init });
    return {
      ok: nextResponse.ok,
      status: nextResponse.status,
      headers: new Map(),
      json: async () => nextResponse.json,
      text: async () => nextResponse.text,
    };
  });
  (globalThis as any).fetch = mock;
  return {
    calls,
    setNextResponse: (response) => {
      nextResponse = { ...nextResponse, ...response };
    },
    restore: () => {
      (globalThis as any).fetch = original;
    },
  };
}

export function parseSentJson(call: CapturedFetch): any {
  if (!call?.init?.body) return null;
  if (typeof call.init.body === 'string') {
    try { return JSON.parse(call.init.body); } catch { return call.init.body; }
  }
  return call.init.body;
}

export function parseSentForm(call: CapturedFetch): Record<string, string> {
  if (!call?.init?.body) return {};
  const params = new URLSearchParams(call.init.body);
  return Object.fromEntries(params.entries());
}
