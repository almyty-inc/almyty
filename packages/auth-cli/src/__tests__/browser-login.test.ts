import { describe, expect, it } from 'vitest';
import { browserLogin } from '../browser-login.js';

describe('browser login callback', () => {
  it('retains the organization chosen during login beside the credential', async () => {
    let announce!: (url: URL) => void;
    const announced = new Promise<URL>(resolve => { announce = resolve; });
    const login = browserLogin({
      frontendUrl: 'http://127.0.0.1:3238', openBrowser: false, timeoutMs: 5_000,
      log: message => { if (message.includes('/cli-login?')) announce(new URL(message.trim())); },
    });
    const url = await announced;
    const callback = url.searchParams.get('callback')!.replace('/cb', '/cb-complete');
    const response = await fetch(callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: url.searchParams.get('state'), token: 'local-test-only', organizationId: 'org-picked' }) });
    expect(response.status).toBe(200);
    expect(await login).toEqual({ token: 'local-test-only', frontendUrl: 'http://127.0.0.1:3238', organizationId: 'org-picked' });
  });
});
