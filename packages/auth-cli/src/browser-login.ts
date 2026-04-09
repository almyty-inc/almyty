/**
 * Browser-based login flow for almyty CLIs (the @almyty/auth package).
 *
 * Inspired by `gh auth login`, `vercel login`, `wrangler login`. Flow:
 *
 *   1. CLI starts a tiny HTTP server bound to 127.0.0.1 on a random port.
 *   2. CLI generates a high-entropy `state` nonce.
 *   3. CLI opens the user's browser to:
 *        {frontendUrl}/cli-login?callback=http://127.0.0.1:PORT/cb&state=STATE
 *   4. The frontend page authenticates the user (existing session OR
 *      normal login) and POSTs the user's JWT back to the callback URL
 *      with the matching state.
 *   5. The local server validates the state, hands the token to the CLI,
 *      shows a success page, and shuts down.
 *
 * Security notes:
 * - The local server only listens on 127.0.0.1 (loopback), so other hosts
 *   on the network can never reach it.
 * - The state nonce is verified server-side (in this CLI process), giving
 *   us CSRF protection against drive-by callbacks.
 * - We accept ONLY POST for the token submission; GET is reserved for the
 *   browser landing page.
 * - The token never appears in a URL — it travels in the POST body so it
 *   doesn't get logged in the browser's history or any reverse proxies.
 *
 * Frontend contract (must exist at {frontendUrl}/cli-login):
 *
 *   On page load, parse `?callback=...&state=...` from the query string.
 *   Validate `callback` starts with `http://127.0.0.1:` and `state` is
 *   present. After the user authenticates (or is already logged in),
 *   POST { token, state } to the callback URL with Content-Type
 *   application/json.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';

export interface BrowserLoginResult {
  token: string;
  frontendUrl: string;
}

export interface BrowserLoginOptions {
  /**
   * Frontend origin that hosts the /cli-login page.
   * Defaults to https://app.almyty.com.
   */
  frontendUrl?: string;
  /**
   * How long to wait for the user to complete the flow before giving up.
   * Defaults to 5 minutes.
   */
  timeoutMs?: number;
  /**
   * Optional logger; defaults to console.error so we don't pollute stdout.
   */
  log?: (msg: string) => void;
  /**
   * Whether to actually open the browser. Defaults to true. Useful to
   * disable in tests.
   */
  openBrowser?: boolean;
}

const SUCCESS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>almyty — login complete</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #09090b; color: #fafafa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { text-align: center; padding: 2rem 3rem; border: 1px solid #27272a; border-radius: 8px; background: #18181b; }
  h1 { color: #8b5cf6; margin: 0 0 0.5rem; font-weight: 600; }
  p { margin: 0.5rem 0; color: #a1a1aa; }
</style>
</head>
<body>
<div class="card">
  <h1>✓ Logged in</h1>
  <p>You can close this tab and return to your terminal.</p>
</div>
</body>
</html>`;

function openInBrowser(url: string, log: (msg: string) => void): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      log(`Could not open browser automatically. Please visit:\n  ${url}`);
    });
    child.unref();
  } catch {
    log(`Could not open browser automatically. Please visit:\n  ${url}`);
  }
}

function readRequestBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (!raw) {
          resolve({});
          return;
        }
        // Parse based on Content-Type. The frontend posts a hidden
        // form (application/x-www-form-urlencoded) to sidestep
        // Chrome's Private Network Access blocking of fetch/XHR to
        // loopback; older clients / curl-based smoke tests may still
        // send JSON. Accept both.
        const contentType = (req.headers['content-type'] || '').toLowerCase();
        if (contentType.startsWith('application/x-www-form-urlencoded')) {
          const params = new URLSearchParams(raw);
          const obj: Record<string, string> = {};
          params.forEach((value, key) => { obj[key] = value; });
          resolve(obj);
          return;
        }
        // Default to JSON.
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function browserLogin(options: BrowserLoginOptions = {}): Promise<BrowserLoginResult> {
  const frontendUrl = (options.frontendUrl || 'https://app.almyty.com').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const log = options.log ?? ((m: string) => process.stderr.write(m + '\n'));
  const shouldOpen = options.openBrowser ?? true;

  const state = randomBytes(32).toString('hex');

  return new Promise((resolve, reject) => {
    let settled = false;
    const settleResolve = (value: BrowserLoginResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(value);
    };
    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      reject(err);
    };

    const debug = process.env.ALMYTY_LOGIN_DEBUG === '1';
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (debug) {
        log(`[debug] ${req.method} ${req.url}  origin=${req.headers.origin || '-'}  ct=${req.headers['content-type'] || '-'}`);
      }
      // CORS for the frontend POST.
      //
      // Critical: modern Chromium blocks fetches from a public HTTPS
      // origin (app.almyty.com) to a loopback address (127.0.0.1)
      // under the Private Network Access (PNA) policy unless the
      // server explicitly opts in. The browser sends
      // `Access-Control-Request-Private-Network: true` on the preflight
      // and expects `Access-Control-Allow-Private-Network: true` in the
      // response. Without this header, Chrome reports:
      //   "Permission was denied for this request to access the
      //    `loopback` address space"
      // and the login flow silently times out. Spec:
      // https://wicg.github.io/private-network-access/
      if (req.method === 'OPTIONS') {
        const pnaRequested =
          (req.headers['access-control-request-private-network'] as string | undefined)?.toLowerCase() === 'true';
        const headers: Record<string, string> = {
          'Access-Control-Allow-Origin': frontendUrl,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        };
        if (pnaRequested) {
          headers['Access-Control-Allow-Private-Network'] = 'true';
        }
        res.writeHead(204, headers);
        res.end();
        return;
      }

      const url = req.url || '/';

      // GET / — health check / "you found the local server" page.
      if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('almyty CLI login server. Waiting for callback…\n');
        return;
      }

      // GET /cb — token landing page. The frontend redirects the
      // top window here with token+state in the URL fragment
      // (`#token=…&state=…`). Fragments are never transmitted over
      // HTTP, so this page receives an empty URL from the server's
      // perspective. It serves a tiny HTML document whose inline
      // script reads the hash client-side and POSTs the data to
      // /cb-complete as a same-origin fetch (which Chrome's
      // Private Network Access policy does NOT block, because
      // both sides are loopback).
      //
      // This two-step dance is necessary because:
      //   - fetch/XHR from HTTPS → loopback is blocked by PNA
      //   - hidden-iframe form POST from HTTPS → loopback is
      //     silently dropped (server never sees it)
      //   - top-window navigation from HTTPS → loopback works
      //   - same-origin fetch within loopback works
      if (req.method === 'GET' && url.startsWith('/cb')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>almyty — finishing login</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #09090b; color: #fafafa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { text-align: center; padding: 2rem 3rem; border: 1px solid #27272a; border-radius: 8px; background: #18181b; max-width: 32rem; }
  h1 { color: #8b5cf6; margin: 0 0 0.5rem; font-weight: 600; font-size: 1.25rem; }
  p { margin: 0.5rem 0; color: #a1a1aa; font-size: 0.875rem; }
  .err { color: #fb7185; }
</style>
</head>
<body>
<div class="card">
<h1 id="t">Finishing login…</h1>
<p id="m">You can close this tab in a moment.</p>
</div>
<script>
(function () {
  var hash = window.location.hash.replace(/^#/, '');
  if (!hash) {
    document.getElementById('t').textContent = 'Login failed';
    document.getElementById('t').className = 'err';
    document.getElementById('m').textContent = 'No credentials were delivered. Return to your terminal and retry.';
    return;
  }
  var params = new URLSearchParams(hash);
  var token = params.get('token');
  var state = params.get('state');
  if (!token || !state) {
    document.getElementById('t').textContent = 'Login failed';
    document.getElementById('t').className = 'err';
    document.getElementById('m').textContent = 'Malformed credentials. Return to your terminal and retry.';
    return;
  }
  // Wipe the fragment out of the URL bar so browsers don't
  // retain the raw token in history even briefly.
  try { history.replaceState({}, '', '/cb'); } catch (_) { /* ignore */ }
  fetch('/cb-complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token, state: state }),
  }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('HTTP ' + r.status)); });
    window.location.href = '/success';
  }).catch(function (err) {
    document.getElementById('t').textContent = 'Login failed';
    document.getElementById('t').className = 'err';
    document.getElementById('m').textContent = String(err && err.message || err);
  });
})();
</script>
</body>
</html>`);
        return;
      }

      // POST /cb-complete — same-origin delivery from /cb's inline
      // script. This is the only path that actually accepts a token.
      // Kept as a separate endpoint so we can reject stray POSTs to
      // /cb with a clear 405 if anything probes it.
      if (req.method === 'POST' && url.startsWith('/cb-complete')) {
        try {
          const body = await readRequestBody(req);
          if (debug) {
            const keys = Object.keys(body).join(',');
            const stateMatch = body.state === state;
            const tokenPresent = typeof body.token === 'string';
            log(`[debug] POST /cb-complete keys=${keys} stateMatch=${stateMatch} tokenPresent=${tokenPresent}`);
          }
          if (!body.state || body.state !== state) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Invalid state');
            return;
          }
          if (!body.token || typeof body.token !== 'string') {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Missing token');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          settleResolve({ token: body.token, frontendUrl });
          return;
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Bad request: ${err.message}`);
          return;
        }
      }

      // POST /cb — legacy JSON/form delivery path (used by curl
      // smoke tests and any non-browser client that doesn't need
      // the PNA workaround). Kept for backwards compatibility with
      // auth flows that don't involve a browser hash redirect.
      if (req.method === 'POST' && url.startsWith('/cb')) {
        try {
          const body = await readRequestBody(req);
          if (debug) {
            const keys = Object.keys(body).join(',');
            const stateMatch = body.state === state;
            const tokenPresent = typeof body.token === 'string';
            log(`[debug] POST /cb (legacy) keys=${keys} stateMatch=${stateMatch} tokenPresent=${tokenPresent}`);
          }
          if (!body.state || body.state !== state) {
            res.writeHead(400, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Access-Control-Allow-Origin': frontendUrl,
            });
            res.end('Invalid state');
            return;
          }
          if (!body.token || typeof body.token !== 'string') {
            res.writeHead(400, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Access-Control-Allow-Origin': frontendUrl,
            });
            res.end('Missing token');
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': frontendUrl,
          });
          res.end(JSON.stringify({ ok: true }));
          settleResolve({ token: body.token, frontendUrl });
          return;
        } catch (err: any) {
          res.writeHead(400, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': frontendUrl,
          });
          res.end(`Bad request: ${err.message}`);
          return;
        }
      }

      // GET /success — landing page after successful POST (the frontend
      // can redirect here so the user sees a friendly confirmation in
      // their browser).
      if (req.method === 'GET' && url.startsWith('/success')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SUCCESS_PAGE);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    });

    server.on('error', (err) => settleReject(err));

    const timer = setTimeout(() => {
      settleReject(new Error(`Login timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      const callbackUrl = `http://127.0.0.1:${port}/cb`;
      const successUrl = `http://127.0.0.1:${port}/success`;
      const loginUrl =
        `${frontendUrl}/cli-login?callback=${encodeURIComponent(callbackUrl)}` +
        `&success=${encodeURIComponent(successUrl)}&state=${state}`;

      log('');
      log('  almyty login');
      log(`  Open your browser to authenticate (auto-opening if available):`);
      log(`    ${loginUrl}`);
      log('');
      log('  Waiting for you to complete login in your browser…');
      log('  (Press Ctrl+C to cancel.)');

      if (shouldOpen) {
        openInBrowser(loginUrl, log);
      }
    });
  });
}
