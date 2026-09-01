import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveClientEntry } from '../build-client-entry';

describe('resolveClientEntry', () => {
  it('uses APP_BUILD_CLIENT_ENTRY when that file exists', async () => {
    const dir = join(tmpdir(), `almyty-client-entry-${process.pid}`);
    const entry = join(dir, 'index.js');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(entry, 'export {}\n');
    try {
      await expect(
        resolveClientEntry({ APP_BUILD_CLIENT_ENTRY: entry }, '/no/such/cwd'),
      ).resolves.toBe(entry);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when APP_BUILD_CLIENT_ENTRY is set but missing', async () => {
    await expect(
      resolveClientEntry(
        { APP_BUILD_CLIENT_ENTRY: '/no/such/almyty-client-entry.js' },
        '/no/such/cwd',
      ),
    ).resolves.toBeNull();
  });

  it('finds the monorepo chat-cli dist when it is present', async () => {
    const backendCwd = join(__dirname, '..', '..', '..', '..');
    const inRepo = join(backendCwd, '..', 'packages', 'chat-cli', 'dist', 'index.js');
    const exists = await fs.stat(inRepo).then(() => true, () => false);
    if (!exists) return;
    await expect(resolveClientEntry({}, backendCwd)).resolves.toBe(inRepo);
  });
});

