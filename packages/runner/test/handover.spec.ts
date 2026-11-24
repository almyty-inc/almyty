import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEnrollSettings } from '../src/enroll.js';
import { takeHandoverFile } from '../src/handover.js';
import { readModelAccess } from '../src/model-proxy.js';

/**
 * A hosted pod hands the runner its tokens as files, and the runner deletes
 * each as it reads it. Passed as variables they stayed readable in
 * /proc/<pid>/environ of tini and the runner for the pod's life, to every
 * command an agent ran there (staging, 2026-11-24), whatever the runner
 * deleted from its own process.env.
 */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'handover-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FAKE_ENROLL = 'fake-enrollment-token-for-tests';
const FAKE_MODEL = 'almyty_pmt_fake-model-token-for-tests';

describe('handed-over token files', () => {
  it('enrolls with the handed-over token and deletes its file', () => {
    writeFileSync(join(dir, 'enrollment-token'), `${FAKE_ENROLL}\n`);
    const env: Record<string, string | undefined> = { ALMYTY_HANDOVER_DIR: dir, ALMYTY_API_URL: 'https://api.example.com' };
    expect(readEnrollSettings(env).token).toBe(FAKE_ENROLL);
    expect(existsSync(join(dir, 'enrollment-token'))).toBe(false);
    expect(JSON.stringify(env)).not.toContain(FAKE_ENROLL);
  });

  it('takes the model token and its expiry from files and deletes both', () => {
    writeFileSync(join(dir, 'model-token'), FAKE_MODEL);
    writeFileSync(join(dir, 'model-token-expires-at'), '2026-11-24T08:00:00.000Z');
    const env: Record<string, string | undefined> = { ALMYTY_HANDOVER_DIR: dir, ALMYTY_MODEL_PROXY_PORT: '4319' };
    const access = readModelAccess(env);
    expect(access?.token).toBe(FAKE_MODEL);
    expect(access?.expiresAt?.toISOString()).toBe('2026-11-24T08:00:00.000Z');
    expect(readdirSync(dir)).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(FAKE_MODEL);
  });

  it('still takes variables from an older backend', () => {
    const env: Record<string, string | undefined> = { ALMYTY_ENROLLMENT_TOKEN: FAKE_ENROLL, ALMYTY_API_URL: 'https://api.example.com' };
    expect(readEnrollSettings(env).token).toBe(FAKE_ENROLL);
    expect(env.ALMYTY_ENROLLMENT_TOKEN).toBeUndefined();
  });

  it('has nothing to take without a folder or a file, and refuses a file it cannot delete', () => {
    expect(takeHandoverFile({}, 'model-token')).toBeNull();
    expect(takeHandoverFile({ ALMYTY_HANDOVER_DIR: dir }, 'model-token')).toBeNull();
    expect(readModelAccess({ ALMYTY_HANDOVER_DIR: dir, ALMYTY_MODEL_PROXY_PORT: '4319' })).toBeNull();
    const stuck = { readFile: () => FAKE_MODEL, unlink: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } };
    expect(() => takeHandoverFile({ ALMYTY_HANDOVER_DIR: dir }, 'model-token', stuck)).toThrow(/cannot delete .*EROFS/);
    expect(() => readEnrollSettings({ ALMYTY_HANDOVER_DIR: dir, ALMYTY_API_URL: 'https://api.example.com' }, { handoverFs: stuck })).toThrow(/cannot delete/);
  });
});
