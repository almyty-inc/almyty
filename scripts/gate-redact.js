'use strict';

/**
 * Secrets out of everything the staging gate prints or writes.
 *
 * Playwright's own error output carries the request's headers, the QA
 * user's session cookies included, and the gate's children (Playwright,
 * the CLI smoke tests) write to the terminal. Every line they print, the
 * report, and the result files left on disk go through `redact`.
 *
 * Shared by scripts/gate-staging.js and the staging fixtures
 * (frontend/tests/staging/support/qa-api.ts), so both hide the same things.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const R = '<redacted>';

/** Names whose value is a credential wherever they appear as name=value or "name": "value". */
const SECRET_NAMES = [
  'access_token', 'refresh_token', 'id_token', 'session', 'session_id', 'sessionid', 'sid',
  'csrf_token', 'xsrf-token', 'x-csrf-token', 'api_key', 'apikey', 'api-key', 'x-api-key',
  'token', 'password', 'secret', 'client_secret', 'clientSecret', 'apiKey', 'initialApiKey', 'key',
];
const NAMES = SECRET_NAMES.map((n) => n.replace(/[-]/g, '\\-')).join('|');

const RULES = [
  // A header line: everything after the header name, up to the end of the
  // line or the closing quote. A Cookie header carries every cookie at once.
  [/\b((?:set-)?cookie|(?:proxy-)?authorization|x-api-key)(["']?\s*:\s*["']?)([^\n"']*)/gi, `$1$2${R}`],
  // {"name": "access_token", "value": "..."}: storage state, trace headers.
  [/("name"\s*:\s*"[^"]*"\s*,\s*"value"\s*:\s*")[^"]*"/g, `$1${R}"`],
  // "access_token": "..." in JSON bodies.
  [new RegExp(`("(?:${NAMES})"\\s*:\\s*")[^"]*"`, 'gi'), `$1${R}"`],
  // access_token=... in cookies, query strings and form bodies.
  [new RegExp(`\\b(${NAMES})=[^\\s;,&"'<>]+`, 'gi'), `$1=${R}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${R}`],
  // JWTs and almyty's own key formats, wherever they are.
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, R],
  [/\b(?:almyty|gw|ak|sk)_[A-Za-z0-9_-]{16,}/g, R],
];

function redact(s) {
  let out = String(s ?? '');
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * A writer that redacts whole lines before passing them on. A secret split
 * across two chunks is still caught, since nothing is written before its
 * line is complete; `end()` flushes the last partial line.
 */
function redactingWriter(write) {
  let pending = '';
  return {
    write(chunk) {
      pending += chunk.toString();
      const cut = pending.lastIndexOf('\n');
      if (cut < 0) return;
      write(redact(pending.slice(0, cut + 1)));
      pending = pending.slice(cut + 1);
    },
    end() {
      if (pending) write(redact(pending));
      pending = '';
    },
  };
}

const TEXT_FILES = /\.(json|md|txt|log|html)$/i;

/** Rewrite every text file under `dir` with its secrets redacted. Returns the files changed. */
function scrubDir(dir) {
  const changed = [];
  if (!fs.existsSync(dir)) return changed;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && TEXT_FILES.test(e.name)) {
        const text = fs.readFileSync(p, 'utf8');
        const clean = redact(text);
        if (clean !== text) {
          fs.writeFileSync(p, clean);
          changed.push(p);
        }
      }
    }
  }
  return changed;
}

/**
 * Run a command with its stdout and stderr redacted line by line on the way
 * to `out` and `err` (the terminal by default). Resolves with the exit code.
 */
function shRedacted(cmd, args, opts = {}, out = process.stdout, err = process.stderr) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['inherit', 'pipe', 'pipe'] });
    const o = redactingWriter((s) => out.write(s));
    const e = redactingWriter((s) => err.write(s));
    child.stdout.on('data', (d) => o.write(d));
    child.stderr.on('data', (d) => e.write(d));
    child.on('error', (error) => {
      e.write(`${error.message}\n`);
      e.end();
      resolve(1);
    });
    child.on('close', (code) => {
      o.end();
      e.end();
      resolve(code ?? 1);
    });
  });
}

module.exports = { redact, redactingWriter, scrubDir, shRedacted };