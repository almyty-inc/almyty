import { promises as fs } from 'fs';
import { join } from 'path';

import { validateUrl } from '../../common/security/url-validator';
import { ResponseTooLargeError, outboundFailureDetail, safeFetch } from '../../common/security/safe-fetch';

/**
 * The icon a packaged app wears.
 *
 * Without one, every customer's desktop app ships with the default
 * Electron logo, which undoes most of what a branded build is for. The
 * icon comes from the product's branding, so it is a URL the customer
 * supplied, which means fetching it is a request to an address they
 * chose and has to be treated as one.
 *
 * electron-builder picks up `build/icon.png` by convention and derives
 * the platform formats from it, so a single square PNG is all a build
 * needs to write.
 */

/** Where electron-builder looks without being told. */
export const ICON_RELATIVE_PATH = join('build', 'icon.png');

/** An icon larger than this is a mistake, not a logo. */
export const MAX_ICON_BYTES = 4 * 1024 * 1024;

/** How long to wait for someone else's server before giving up. */
export const ICON_FETCH_TIMEOUT_MS = 10_000;

export interface IconOutcome {
  /** Whether a usable icon was written. */
  written: boolean;
  /** A sentence for the operator when it was not. */
  reason: string | null;
}

/** Whether these bytes actually are a PNG. */
export function looksLikePng(data: Buffer): boolean {
  // The 8-byte signature. Trusting the URL's extension or the server's
  // content-type would let anything through, and this file is handed to
  // an image toolchain.
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return data.length > signature.length && data.subarray(0, 8).equals(signature);
}

/**
 * Fetch bytes from a customer-supplied URL.
 *
 * Through the shared guarded client: a link to 169.254.169.254 or to
 * something on the build host's own network is refused (by string, and at
 * connect time for a name that resolves there), a redirect is refused, the
 * body stops at MAX_ICON_BYTES, and the deadline is for the whole
 * download -- the old socket idle timer let a server that drips a byte at
 * a time hold the build forever.
 */
export async function fetchIconBytes(url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await safeFetch(url, { maxBytes: MAX_ICON_BYTES, timeoutMs: ICON_FETCH_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ResponseTooLargeError) throw new Error('it is larger than an icon should be');
    throw new Error(outboundFailureDetail(err));
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('the server did not return it');
  }
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof ResponseTooLargeError) throw new Error('it is larger than an icon should be');
    throw new Error(outboundFailureDetail(err));
  }
}

/**
 * Put the product's icon where the packager will find it.
 *
 * Never fails the build. A missing or unreachable icon means the app
 * ships with the default one, which is worse than branded but far
 * better than no artifact, and the operator is told which happened.
 */
export async function writeIcon(
  iconUrl: string | null | undefined,
  projectDir: string,
  fetcher: (url: string) => Promise<Buffer> = fetchIconBytes,
): Promise<IconOutcome> {
  if (!iconUrl) {
    return { written: false, reason: 'No icon is set, so it ships with the default one.' };
  }

  const validation = validateUrl(iconUrl);
  if (!validation.valid) {
    return {
      written: false,
      reason: `That icon address was refused (${validation.error}), so it ships with the default one.`,
    };
  }

  let data: Buffer;
  try {
    data = await fetcher(iconUrl);
  } catch (err: any) {
    return {
      written: false,
      reason: `The icon could not be fetched because ${err?.message ?? 'of an error'}, so it ships with the default one.`,
    };
  }

  return placeIcon(data, projectDir);
}

/** Write icon bytes where the packager finds them, when they are a PNG. */
async function placeIcon(data: Buffer, projectDir: string): Promise<IconOutcome> {
  if (!looksLikePng(data)) {
    return {
      written: false,
      reason: 'The icon is not a PNG, so it ships with the default one.',
    };
  }
  if (data.length > MAX_ICON_BYTES) {
    return { written: false, reason: 'The icon is larger than an icon should be, so it ships with the default one.' };
  }

  const target = join(projectDir, ICON_RELATIVE_PATH);
  await fs.mkdir(join(projectDir, 'build'), { recursive: true });
  await fs.writeFile(target, data);

  return { written: true, reason: null };
}

/**
 * The icon a build wears, from the branding: the one uploaded on the
 * branding page (a file of the channel's organization, read from storage,
 * no request to anyone's server) before an icon address set through the
 * API. Never fails the build, like writeIcon.
 */
export async function writeBrandingIcon(
  branding: { iconFileId?: string | null; iconUrl?: string | null },
  projectDir: string,
  readUploaded: ((fileId: string) => Promise<Buffer>) | null,
  fetcher: (url: string) => Promise<Buffer> = fetchIconBytes,
): Promise<IconOutcome> {
  if (!branding.iconFileId) return writeIcon(branding.iconUrl, projectDir, fetcher);
  if (!readUploaded) {
    return { written: false, reason: 'The uploaded icon cannot be read on this build host, so it ships with the default one.' };
  }
  let data: Buffer;
  try {
    data = await readUploaded(branding.iconFileId);
  } catch {
    return { written: false, reason: 'The uploaded icon could not be read, so it ships with the default one.' };
  }
  return placeIcon(data, projectDir);
}
