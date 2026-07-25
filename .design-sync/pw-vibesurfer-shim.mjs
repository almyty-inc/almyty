// Playwright-compatible shim backed by the vibesurfer `vs` CLI.
//
// Why: this repo's design-sync runs capture via vibesurfer (a real WKWebView
// driven over a Unix-socket daemon) instead of Playwright + chromium. The
// converter (package-capture.mjs, package-validate.mjs) does
// `await import('playwright')` and uses a small slice of the API:
// chromium.launch → browser.newPage({viewport}) → page.goto / page.evaluate /
// page.screenshot / page.setContent / page.setViewportSize /
// page.waitForFunction / page.on('pageerror') → browser.close.
//
// CRITICAL: every `vs` call MUST be async (execFile, not execFileSync). The
// converter serves the bundle over HTTP *in its own process*; vibesurfer's
// WKWebView then connects back to that server. A synchronous subprocess call
// blocks the converter's event loop, so the in-process HTTP server can't accept
// the daemon's connection and every navigation fails with "Could not connect to
// the server." Async keeps the loop free while `vs` runs.
//
// Re-sync note: the two staged scripts under .ds-sync/ are re-copied from the
// bundled skill each run, so their `import('playwright')` → this shim swap must
// be re-applied. See .design-sync/NOTES.md ("vibesurfer capture fork").

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, copyFile } from 'node:fs/promises';

const pexec = promisify(execFile);
const VS = process.env.DS_VS_BIN || 'vs';

async function vs(args, { allowError = false } = {}) {
  let stdout;
  try {
    ({ stdout } = await pexec(VS, [...args, '--json'], { maxBuffer: 96 * 1024 * 1024 }));
  } catch (e) {
    if (allowError) return { body: [], envelope: { kind: 'error' } };
    throw new Error(`vs ${args.slice(0, 2).join(' ')} failed: ${e.message.split('\n')[0]}`);
  }
  let j;
  try { j = JSON.parse(stdout); }
  catch { throw new Error(`vs ${args.slice(0, 2).join(' ')}: non-JSON response`); }
  if (j.envelope?.kind === 'error' && !allowError) {
    throw new Error(`vs ${args.slice(0, 2).join(' ')}: ${JSON.stringify(j.envelope)}`);
  }
  return j;
}
const body0 = (j) => (j.body && j.body[0]) || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Page {
  constructor(session, viewport) {
    this.session = session;
    this.viewport = viewport || { width: 1200, height: 800 };
    this.pageId = null;
    this._onPageError = [];
    // No vibesurfer clock primitive — leave `clock` undefined so the
    // converter's `try { page.clock.setFixedTime() } catch {}` no-ops.
  }
  _S() { return ['-S', this.session]; }

  on(event, cb) {
    if (event === 'pageerror') this._onPageError.push(cb);
  }

  async _setViewport() {
    if (!this.pageId) return;
    await vs(['viewport', this.pageId, `${this.viewport.width}x${this.viewport.height}`, ...this._S()], { allowError: true });
  }

  async setViewportSize(vp) {
    if (vp && vp.width && vp.height) this.viewport = { width: vp.width, height: vp.height };
    await this._setViewport();
  }

  async _settle(timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if ((await this._evalRaw(`document.readyState === 'complete'`)) === true) break;
      } catch { /* keep polling */ }
      await sleep(120);
    }
    // brief paint settle for async-mounting React previews
    await sleep(250);
  }

  async _dispatchPageErrors() {
    if (!this._onPageError.length || !this.pageId) return;
    const j = await vs(['inspect', this.pageId, 'console', '--level', 'error', ...this._S()], { allowError: true });
    for (const line of j.body || []) {
      const msg = String(line).replace(/^.*?\t/, '').trim();
      if (msg) for (const cb of this._onPageError) cb(msg);
    }
  }

  async _open(url) {
    if (this.pageId) { await vs(['close', this.pageId, ...this._S()], { allowError: true }); this.pageId = null; }
    this.pageId = body0(await vs(['open', url, ...this._S()]));
    await this._setViewport();
  }

  async goto(url /*, opts */) {
    await this._open(url);
    await this._settle();
    await this._dispatchPageErrors();
    return { ok: () => true, status: () => 200 };
  }

  async setContent(html) {
    // Used only by the bundle-export smoke (wrapped in try/catch upstream).
    await this._open('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await this._settle(4000);
  }

  // Evaluate `expr` in the page, returning the parsed JSON value.
  async _evalRaw(expr) {
    const j = await vs(['inspect', this.pageId, 'eval', expr, ...this._S()]);
    const line = (j.body || []).find((b) => String(b).startsWith('result=')) ?? '';
    const raw = String(line).slice('result='.length);
    if (raw === '' || raw === 'undefined') return undefined;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  async evaluate(fn, arg) {
    const f = typeof fn === 'function' ? fn.toString() : String(fn);
    const a = arg === undefined ? '' : JSON.stringify(arg);
    // `vs inspect eval` rejects multiline expressions (BAD_REQUEST), and the
    // converter's evaluate functions are multiline (with // comments, so newlines
    // can't just be collapsed). Base64-encode the function source and decode +
    // eval it inside the page, keeping the wire expression strictly single-line.
    const b64 = Buffer.from(`(${f})`).toString('base64');
    return this._evalRaw(`JSON.stringify(((0,eval)(atob(${JSON.stringify(b64)})))(${a}))`);
  }

  async waitForFunction(fn, arg, opts = {}) {
    const deadline = Date.now() + (opts.timeout ?? 5000);
    while (Date.now() < deadline) {
      try { if (await this.evaluate(fn, arg)) return; } catch { /* keep polling */ }
      await sleep(150);
    }
    throw new Error('waitForFunction: timeout');
  }

  async screenshot(opts = {}) {
    const args = ['capture', this.pageId, ...this._S()];
    if (opts.fullPage) args.push('--full-page');
    const src = body0(await vs(args));
    if (!src) return null;
    if (opts.path) await copyFile(src, opts.path);
    return readFile(src);
  }
}

class Browser {
  constructor(session) { this.session = session; }
  async newPage(opts = {}) { return new Page(this.session, opts.viewport); }
  async newContext() { return { newPage: (o) => this.newPage(o) }; }
  async close() { await vs(['session-close', '-S', this.session], { allowError: true }); }
}

export const chromium = {
  async launch(/* opts */) {
    const session = body0(await vs(['session-open']));
    if (!session) throw new Error('vs session-open returned no session id');
    return new Browser(session);
  },
};

export default { chromium };
