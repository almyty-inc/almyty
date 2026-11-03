/**
 * How long a live stream waits before each attempt to reconnect, in ms:
 * quick at first, then backing off. Shared by the Runs tab's live run
 * (hooks/use-live-run.ts) and the hosted chat's reply stream.
 */
export const STREAM_RECONNECT_DELAYS_MS: ReadonlyArray<number> = [500, 1_000, 2_000, 5_000, 10_000]