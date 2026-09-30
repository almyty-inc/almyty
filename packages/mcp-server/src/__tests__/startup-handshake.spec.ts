/**
 * The MCP lifecycle: until the client has sent `notifications/initialized`,
 * the server may answer requests but must not send notifications of its
 * own. Discovery runs right after the transport connects, and when it fails
 * fast (backend down, connection refused) the prompt registration that
 * follows used to emit `notifications/prompts/list_changed` before the
 * client had even sent `initialize`. A strict client drops the server for
 * that.
 *
 * This drives the real entry point over stdio against a port nothing
 * listens on, waits until discovery has failed, and only then starts the
 * handshake.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

type Message = { jsonrpc: '2.0'; id?: number; method?: string; result?: unknown };

const packageDir = join(import.meta.dirname, '..', '..');

/** A port that was free a moment ago, so a connect to it is refused at once. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function waitFor(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let child: ChildProcessWithoutNullStreams | undefined;
let home: string | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe('startup handshake', () => {
  it('sends no notification before the client has finished initializing, even when discovery fails fast', async () => {
    home = mkdtempSync(join(tmpdir(), 'almyty-mcp-handshake-'));
    const port = await closedPort();

    child = spawn(process.execPath, ['--import', 'tsx', join('src', 'index.ts'), 'acme/petstore'], {
      cwd: packageDir,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ALMYTY_TOKEN: 'test-token',
        ALMYTY_URL: `http://127.0.0.1:${port}`,
        ALMYTY_MODE: 'skill-first',
      },
    });

    const messages: Message[] = [];
    let stderr = '';
    let buffered = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) messages.push(JSON.parse(line));
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const send = (message: Record<string, unknown>) =>
      child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

    // Discovery has failed, and whatever follows it has had time to run.
    await waitFor(() => stderr.includes('gateway discovery failed'), 'discovery to fail');
    await pause(300);
    expect(messages).toEqual([]);

    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spec', version: '0' } },
    });
    await waitFor(() => messages.some((m) => m.id === 1), 'the initialize response');
    await pause(300);
    expect(messages.map((m) => m.method ?? `response:${m.id}`)).toEqual(['response:1']);

    // Once the client says it is ready, the late registrations are announced.
    send({ method: 'notifications/initialized' });
    await waitFor(
      () => messages.some((m) => m.method === 'notifications/prompts/list_changed'),
      'prompts/list_changed after initialized',
    );
    expect(messages[0].id).toBe(1);
  }, 30_000);
});
