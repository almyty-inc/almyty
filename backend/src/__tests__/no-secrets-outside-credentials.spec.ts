import * as fs from 'fs';
import * as path from 'path';

/**
 * Ratchet: no entity may grow a column that holds a third-party secret
 * outside the credential store. Every `@Column` in src/entities is
 * scanned for a secret-looking property name, for secret-looking keys
 * inside an inline object type, and for keys of an interface declared
 * in the same file that the column is typed with. A hit must be on the
 * allow-list below, and every allow-list entry must still be a hit, so
 * the list only shrinks. Add a secret column and this spec fails the
 * build; the answer is a `credentialId` reference resolved through
 * CredentialRefResolver.
 *
 * Limit: a `Record<string, any>` column is opaque to the scan (its
 * name is checked, its keys cannot be). Those stores are listed in
 * docs/connections.md under "Where secrets live".
 */

const SECRET_NAME = /(secret|token|password|passwd|apikey|api_key|privatekey|private_key|credential|bearer|accesskey|access_key|clientsecret)/i;

/** Names that match the pattern but hold no secret: ids, hashes, counters, types, timestamps. */
const NOT_A_SECRET = [
  /(Id|Ids|Hash|Prefix|Type|Method|At|Count|Cost|Version|Expires|Endpoint|Url|Location|Name|Kind|Policy|Limit|Enabled|Ttl|Scopes|Granted|Status|Path|Header)$/,
  /^credentialId$/,
  /tokens/i,
  /^(max|total|input|output|prompt|completion|cached|reasoning)Tokens?$/i,
];

/** The store itself: the one column meant to hold secrets. Checked for presence, not as a hit (its keys are opaque). */
const STORE = 'credential.entity.ts:config';

/**
 * Columns allowed to carry a secret, as `<file>:<column>`. Read-through
 * shims carry the date their column goes away; first-party tokens
 * almyty issues itself are not third-party secrets and stay.
 */
const ALLOWED: Record<string, string> = {
  'llm-provider.entity.ts:configuration': 'shim for apiKey / usageApiKey (moved by the startup backfill); bedrock.* keys unused. TODO(2026-12-01) drop',
  'mcp-source.entity.ts:authConfig': 'shim, moved by the startup backfill. TODO(2026-12-01) drop',
  'channel-installation.entity.ts:credentials': 'shim, moved by the startup backfill. TODO(2026-12-01) drop',
  'gateway.entity.ts:webhooks': 'outbound webhook signing secret inside the json. TODO(2026-12-01) reference a credential',
  'audit-stream-config.entity.ts:token': 'audit stream target token (EE). TODO(2026-12-01) reference a credential',
  'org-sso-config.entity.ts:oidcClientSecret': 'SSO client secret (EE). TODO(2026-12-01) reference a credential',
  'org-sso-config.entity.ts:scimTokenEncrypted': 'SCIM bearer copy for re-display (EE). TODO(2026-12-01) reference a credential',
  'user.entity.ts:verificationToken': 'first-party e-mail verification token',
  'user.entity.ts:resetPasswordToken': 'first-party password reset token',
  'user-organization.entity.ts:inviteToken': 'first-party invite token',
};

interface ScannedColumn {
  file: string;
  column: string;
  nestedKeys: string[];
}

function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) && !NOT_A_SECRET.some((rx) => rx.test(name));
}

/** A property line inside an object type; boolean and number keys are never secrets. */
function nestedKeyOf(line: string): string | null {
  if (/^\s*\*/.test(line)) return null;
  const key = line.match(/^\s*([A-Za-z_]\w*)\s*\??\s*:\s*([A-Za-z_][\w.]*)?/);
  if (!key) return null;
  if (key[2] === 'boolean' || key[2] === 'number') return null;
  return key[1];
}

/** `interface Name { ... }` blocks of the file: name -> keys. */
function interfacesOf(lines: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(?:export\s+)?interface\s+([A-Za-z_]\w*)\b.*\{\s*$/);
    if (!open) continue;
    const keys: string[] = [];
    let depth = 1;
    for (i = i + 1; i < lines.length && depth > 0; i++) {
      const line = lines[i];
      if (depth === 1) {
        const key = nestedKeyOf(line);
        if (key) keys.push(key);
      }
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    }
    out.set(open[1], keys);
    i--;
  }
  return out;
}

/** Every @Column property of an entity file with the identifiers found inside its type. */
export function scanEntityColumns(source: string, file: string): ScannedColumn[] {
  const lines = source.split('\n');
  const interfaces = interfacesOf(lines);
  const out: ScannedColumn[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*@Column\(/.test(lines[i])) { i++; continue; }
    // Skip the decorator (may span lines) and any further decorators.
    let depth = 0;
    do {
      depth += (lines[i].match(/\(/g) ?? []).length - (lines[i].match(/\)/g) ?? []).length;
      i++;
    } while (i < lines.length && depth > 0);
    while (i < lines.length && /^\s*@/.test(lines[i])) i++;
    if (i >= lines.length) break;
    const prop = lines[i].match(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*[?!]?\s*:\s*([A-Za-z_]\w*)?/);
    if (!prop) { i++; continue; }
    const column = prop[1];
    const nestedKeys: string[] = [...(interfaces.get(prop[2] ?? '') ?? [])];
    let braces = (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
    let ended = braces === 0 && /;\s*(\/\/.*)?$/.test(lines[i]);
    i++;
    while (!ended && i < lines.length) {
      const line = lines[i];
      const key = nestedKeyOf(line);
      if (key) nestedKeys.push(key);
      braces += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      ended = braces <= 0 && /;\s*(\/\/.*)?$/.test(line);
      i++;
    }
    out.push({ file, column, nestedKeys });
  }
  return out;
}

function entityFiles(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.entity.ts'))
    .map((f) => path.join(dir, f));
}

describe('no secret column outside the credential store', () => {
  const dir = path.join(__dirname, '..', 'entities');
  const columns = entityFiles(dir).flatMap((file) => scanEntityColumns(fs.readFileSync(file, 'utf8'), path.basename(file)));
  const hits = columns
    .filter((c) => isSecretName(c.column) || c.nestedKeys.some(isSecretName))
    .map((c) => `${c.file}:${c.column}`);

  it('scans the entity tree and finds the store', () => {
    expect(columns.length).toBeGreaterThan(100);
    expect(columns.map((c) => `${c.file}:${c.column}`)).toContain(STORE);
  });

  it('flags every secret-looking column or nested key, and each one is on the shrinking allow-list', () => {
    const unexpected = hits.filter((h) => !ALLOWED[h]);
    expect(unexpected).toEqual([]);
  });

  it('every allow-list entry is still a real hit (remove the entry when the column goes)', () => {
    const stale = Object.keys(ALLOWED).filter((k) => !hits.includes(k));
    expect(stale).toEqual([]);
  });

  it('the scanner sees names, inline keys and interface-typed columns', () => {
    const sample = `
      export interface Cfg {
        apiKey?: string;
        model?: string;
        flag: boolean;
      }

      @Column({ type: 'json', nullable: true })
      authConfig: {
        bearerToken?: string;
        headers?: Record<string, string>;
        credentials: boolean;
      } | null;

      @Column()
      name: string;

      @Column({ type: 'json' })
      configuration: Cfg;

      @Column({ type: 'uuid', nullable: true })
      credentialId: string | null;
    `;
    expect(scanEntityColumns(sample, 'x.entity.ts')).toEqual([
      { file: 'x.entity.ts', column: 'authConfig', nestedKeys: ['bearerToken', 'headers'] },
      { file: 'x.entity.ts', column: 'name', nestedKeys: [] },
      { file: 'x.entity.ts', column: 'configuration', nestedKeys: ['apiKey', 'model'] },
      { file: 'x.entity.ts', column: 'credentialId', nestedKeys: [] },
    ]);
    expect(isSecretName('bearerToken')).toBe(true);
    expect(isSecretName('credentialId')).toBe(false);
    expect(isSecretName('totalTokensUsed')).toBe(false);
    expect(isSecretName('tokenHash')).toBe(false);
    expect(isSecretName('credentials')).toBe(true);
  });
});
