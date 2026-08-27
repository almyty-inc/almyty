import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  ICON_RELATIVE_PATH,
  MAX_ICON_BYTES,
  looksLikePng,
  writeIcon,
} from '../build-icon';

/**
 * The icon a packaged app wears.
 *
 * It comes from a URL the customer supplied, so fetching it is a
 * request to an address they chose. These cover what happens when that
 * address is hostile, unreachable, or points at something that is not
 * an image — none of which may fail the build, because a default icon
 * beats no artifact.
 */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('the rest of a png'),
]);

describe('looksLikePng', () => {
  it('recognises a PNG by its signature', () => {
    expect(looksLikePng(PNG)).toBe(true);
  });

  it('refuses something merely named .png', () => {
    // The URL's extension and the server's content-type are both the
    // remote end's opinion, and this file is handed to an image
    // toolchain.
    expect(looksLikePng(Buffer.from('<html>not an image</html>'))).toBe(false);
    expect(looksLikePng(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
  });

  it('refuses a buffer too short to have a signature', () => {
    expect(looksLikePng(Buffer.from([0x89, 0x50]))).toBe(false);
    expect(looksLikePng(Buffer.alloc(0))).toBe(false);
  });
});

describe('writeIcon', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(join(tmpdir(), 'icon-test-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  const iconPath = () => join(projectDir, ICON_RELATIVE_PATH);

  it('writes the icon where the packager looks for it', async () => {
    const result = await writeIcon('https://cdn.example/logo.png', projectDir, async () => PNG);

    expect(result).toEqual({ written: true, reason: null });
    expect(await fs.readFile(iconPath())).toEqual(PNG);
  });

  it('says the app ships with the default when no icon is set', async () => {
    const result = await writeIcon(null, projectDir, async () => PNG);

    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/default/i);
    await expect(fs.stat(iconPath())).rejects.toThrow();
  });

  it('refuses an address the URL validator rejects', async () => {
    // A branding field is customer input, and this fetch runs from the
    // build host's own network.
    const fetcher = jest.fn();
    const result = await writeIcon('http://169.254.169.254/latest/meta-data', projectDir, fetcher);

    expect(result.written).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a scheme that is not http', async () => {
    const fetcher = jest.fn();
    const result = await writeIcon('file:///etc/passwd', projectDir, fetcher);

    expect(result.written).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('carries on when the icon cannot be fetched', async () => {
    const result = await writeIcon('https://cdn.example/logo.png', projectDir, async () => {
      throw new Error('the server answered 404');
    });

    expect(result.written).toBe(false);
    expect(result.reason).toContain('404');
    await expect(fs.stat(iconPath())).rejects.toThrow();
  });

  it('refuses bytes that are not a PNG rather than packaging them', async () => {
    const result = await writeIcon('https://cdn.example/logo.png', projectDir, async () =>
      Buffer.from('<html>login page</html>'),
    );

    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/not a png/i);
    await expect(fs.stat(iconPath())).rejects.toThrow();
  });

  it('never throws, because a default icon beats no artifact', async () => {
    // Every path above returns rather than rejecting; this pins that.
    await expect(
      writeIcon('https://cdn.example/logo.png', projectDir, async () => {
        throw new Error('boom');
      }),
    ).resolves.toMatchObject({ written: false });
  });

  it('has a size ceiling, so a link is not a way to fill the disk', () => {
    expect(MAX_ICON_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
