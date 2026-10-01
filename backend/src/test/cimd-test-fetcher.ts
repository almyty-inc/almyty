import type { CimdFetcher } from '../modules/mcp/services/mcp-oauth-cimd.service';

/**
 * The Client ID Metadata Document fetcher TestAppModule installs.
 *
 * The real one (safeCimdFetcher) refuses every loopback address, which is
 * exactly what a spec's local document server is. A spec that exercises a
 * metadata-document client points `serve` at its server; anything else is
 * refused the way an unreachable document is.
 */
export const cimdTestDocuments: { serve: CimdFetcher | null } = { serve: null };

export const testCimdFetcher: CimdFetcher = async (url, limits) => {
  if (!cimdTestDocuments.serve) throw new Error('no client metadata document is served in this spec');
  return cimdTestDocuments.serve(url, limits);
};