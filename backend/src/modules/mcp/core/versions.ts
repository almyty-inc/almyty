/**
 * MCP protocol versions: which ones this server answers, and what each
 * one allows on the wire.
 *
 * Every per-version difference the core applies lives in this table, not
 * in `if` chains across the handlers (docs/design/mcp-2026-07-28.md,
 * "Architecture: one protocol core"). A surface returns the richest result
 * it can; the core strips what the negotiated version does not define.
 *
 * Which versions are answered at all is configuration
 * (`MCP_PROTOCOL_VERSIONS`, see mcp-settings.ts). This file only knows
 * what each revision means.
 */

/** Every revision this code knows how to speak, newest first. */
export const KNOWN_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type ProtocolVersion = (typeof KNOWN_PROTOCOL_VERSIONS)[number];

/**
 * The versions the docs claim, and that conformance and Inspector run
 * against. The older two are still answered (owner decision 2: until the
 * request log shows no use) but are not claimed.
 */
export const CLAIMED_PROTOCOL_VERSIONS: readonly ProtocolVersion[] = ['2025-11-25', '2025-06-18'];

/**
 * The version a request without an `MCP-Protocol-Version` header is
 * treated as. Fixed by the spec (2025-06-18 transports, "Protocol Version
 * Header"): "the server SHOULD assume protocol version 2025-03-26". Not a
 * tunable.
 */
export const VERSION_WITHOUT_HEADER: ProtocolVersion = '2025-03-26';

export interface VersionFeatures {
  /** JSON-RPC batches. Removed in 2025-06-18 (changelog Major 1). */
  batch: boolean;
  /** Tool `annotations`. Added in 2025-03-26. */
  toolAnnotations: boolean;
  /** Tool `title`. Added in 2025-06-18 (Minor 3). */
  toolTitle: boolean;
  /** Tool `outputSchema` and result `structuredContent`. Added in 2025-06-18 (Major 2). */
  structuredContent: boolean;
  /** `resource_link` content blocks. Added in 2025-06-18 (Major 7). */
  resourceLinks: boolean;
  /** Tool and implementation `icons`. Added in 2025-11-25 (Major 2). */
  icons: boolean;
}

export const VERSION_FEATURES: Record<ProtocolVersion, VersionFeatures> = {
  '2024-11-05': {
    batch: true,
    toolAnnotations: false,
    toolTitle: false,
    structuredContent: false,
    resourceLinks: false,
    icons: false,
  },
  '2025-03-26': {
    batch: true,
    toolAnnotations: true,
    toolTitle: false,
    structuredContent: false,
    resourceLinks: false,
    icons: false,
  },
  '2025-06-18': {
    batch: false,
    toolAnnotations: true,
    toolTitle: true,
    structuredContent: true,
    resourceLinks: true,
    icons: false,
  },
  '2025-11-25': {
    batch: false,
    toolAnnotations: true,
    toolTitle: true,
    structuredContent: true,
    resourceLinks: true,
    icons: true,
  },
};

export function isKnownVersion(value: unknown): value is ProtocolVersion {
  return typeof value === 'string' && (KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

export function featuresOf(version: string): VersionFeatures {
  return isKnownVersion(version) ? VERSION_FEATURES[version] : VERSION_FEATURES[VERSION_WITHOUT_HEADER];
}

/** The newest of a set of versions (ISO dates sort as strings). */
export function newestOf(versions: readonly ProtocolVersion[]): ProtocolVersion {
  return [...versions].sort().reverse()[0] ?? KNOWN_PROTOCOL_VERSIONS[0];
}

/**
 * The version an `initialize` is answered with.
 *
 * Lifecycle, "Version Negotiation": a server that supports the requested
 * version MUST answer with it; otherwise it MUST answer with another
 * version it supports, and SHOULD pick its latest. A client that cannot
 * use the answer disconnects. So there is no error here: an unknown,
 * older or newer request gets our newest supported version.
 */
export function negotiateVersion(requested: unknown, supported: readonly ProtocolVersion[]): ProtocolVersion {
  if (isKnownVersion(requested) && supported.includes(requested)) return requested;
  return newestOf(supported);
}
