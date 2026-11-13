/**
 * A bare agent name after `almyty login`.
 *
 * The browser login stores an almyty_ API key and the organization the
 * person picked. chat-cli read the organization only out of a JWT, so
 * every bare name (and every bare ALMYTY_AGENT) was refused with "Cannot
 * tell which organization to use" (nine staging gate tests). This runs the
 * real entry point against a credentials file written the way the login
 * writes it and a stand-in API, and checks which agent it asked for.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ORG_ID = '5b0f8a52-3c1e-4d7a-9f3e-0c2b1a9d8e77';
const packageDir = join(import.meta.dirname, '..', '..');

let api: Server | undefined;
let home: string | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (api ? api.close(() => resolve()) : resolve()));
  api = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

async function standInApi(paths: string[]): Promise<string> {
  api = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 404, message: 'Agent not found' }));
  });
  await new Promise<void>((resolve) => api!.listen(0, '127.0.0.1', () => resolve()));
  const address = api.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join('src', 'index.tsx'), ...args], {
      cwd: packageDir,
      env: { ...process.env, ALMYTY_TOKEN: '', ALMYTY_AGENT: '', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (c: string) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

describe('a bare agent name after almyty login', () => {
  for (const [how, args, env] of [
    ['as the argument', ['support-bot', '--message', 'hi'], {}],
    ['as ALMYTY_AGENT', ['--message', 'hi'], { ALMYTY_AGENT: 'support-bot' }],
  ] as const) {
    it(`is looked up in the organization the login chose (${how})`, async () => {
      const paths: string[] = [];
      const url = await standInApi(paths);
      home = mkdtempSync(join(tmpdir(), 'almyty-chat-org-'));
      mkdirSync(join(home, '.almyty'));
      // What `almyty login` writes: an API key, not a JWT, and the org id.
      writeFileSync(join(home, '.almyty', 'credentials.json'), JSON.stringify({ url, token: 'almyty_sk_not_a_jwt_0123456789', organizationId: ORG_ID }));

      const { code, stderr } = await run([...args], { HOME: home, USERPROFILE: home, ...env });

      expect(stderr).not.toContain('Cannot tell which organization');
      expect(paths.some((p) => p.startsWith(`/${ORG_ID}/support-bot`))).toBe(true);
      // The stand-in has no such agent: not found, not a usage error.
      expect(code).toBe(4);
    }, 30_000);
  }
});
