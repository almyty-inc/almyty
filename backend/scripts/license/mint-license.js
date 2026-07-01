#!/usr/bin/env node
/**
 * Dev license-minting tool. Signs an entitlement token with the LOCAL dev
 * private key (backend/scripts/license/dev-private-key.pem), whose matching
 * public key is the built-in default in the licensing module. Use it to
 * activate EE features locally:
 *
 *   node backend/scripts/license/mint-license.js \
 *     --entitlements sso,advanced_rbac --seats 50 --expires 2027-01-01 \
 *     --issued-to "Acme Corp"
 *
 * Then run the backend with:  ALMYTY_LICENSE_KEY=<printed token>
 *
 * PRODUCTION signing uses an offline vendor key, NOT this dev key. This dev key
 * is committed on purpose: it only unlocks a locally-built binary and carries no
 * security value against a hardened deployment that overrides the public key.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const args = parseArgs(process.argv);

const entitlements = (args.entitlements ? String(args.entitlements) : '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const limits = {};
if (args.seats) limits.seats = Number(args.seats);

const payload = {
  entitlements,
  limits,
  expiresAt: args.expires ? new Date(String(args.expires)).toISOString() : null,
  issuedTo: args['issued-to'] ? String(args['issued-to']) : undefined,
  issuedAt: new Date().toISOString(),
};

const keyPath = args.key
  ? String(args.key)
  : process.env.ALMYTY_LICENSE_PRIVATE_KEY_FILE;
if (!keyPath) {
  console.error(
    'No signing key. Pass --key <path> or set ALMYTY_LICENSE_PRIVATE_KEY_FILE.\n' +
      'No private key is committed to the repo (it would let anyone forge licenses).',
  );
  process.exit(1);
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));

const payloadPart = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
const signingInput = `v1.${payloadPart}`;
const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), privateKey);
const token = `${signingInput}.${base64url(signature)}`;

process.stderr.write(`payload: ${JSON.stringify(payload, null, 2)}\n\n`);
process.stdout.write(token + '\n');
