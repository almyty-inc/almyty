import { promises as fs } from 'fs';
import { join } from 'path';
import * as http from 'http';
import * as https from 'https';

import { validateUrl } from '../../common/security/url-validator';
import { ssrfSafeHttpAgent, ssrfSafeHttpsAgent } from '../../common/security/ssrf-safe-agent';

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
 * Uses the SSRF-safe agents so a link to 169.254.169.254 or to
 * something on the build host's own network is refused at connect time
 * rather than fetched and packaged.
 */
export function fetchIconBytes(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const agent = parsed.protocol === 'https:' ? ssrfSafeHttpsAgent : ssrfSafeHttpAgent;

    const request = client.get(
      url,
      { agent, timeout: ICON_FETCH_TIMEOUT_MS },
      (response) => {
        if ((response.statusCode ?? 0) >= 400) {
          response.resume();
          reject(new Error(`the server answered ${response.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;

        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ICON_BYTES) {
            // Stop reading rather than buffering whatever is on the
            // other end of a link we did not choose.
            request.destroy();
            reject(new Error('it is larger than an icon should be'));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      },
    );

    request.on('timeout', () => {
      request.destroy();
      reject(new Error('the server did not answer in time'));
    });
    request.on('error', reject);
  });
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

  if (!looksLikePng(data)) {
    return {
      written: false,
      reason: 'The icon is not a PNG, so it ships with the default one.',
    };
  }

  const target = join(projectDir, ICON_RELATIVE_PATH);
  await fs.mkdir(join(projectDir, 'build'), { recursive: true });
  await fs.writeFile(target, data);

  return { written: true, reason: null };
}
