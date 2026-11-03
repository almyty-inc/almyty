/**
 * Open a server-sent events response so it reaches the client at once.
 *
 * Headers alone are not enough: a proxy in between (vite's dev proxy,
 * nginx, an ingress, a CDN) can hold the response until its first body
 * byte, and a stream with nothing to say yet would then sit unanswered
 * until its first event or keep-alive. The viewer sees "Connecting" for
 * that long. So the stream opens with an SSE comment, which every client
 * ignores, and says it must not be buffered or transformed.
 */
export interface EventStreamResponse {
  setHeader(name: string, value: string): unknown;
  flushHeaders?: () => void;
  write(chunk: string): unknown;
}

export const EVENT_STREAM_OPENING = ': open\n\n';

export function openEventStream(res: EventStreamResponse): void {
  res.setHeader('Content-Type', 'text/event-stream');
  // no-transform: a proxy may not compress or rewrite it, which would buffer it.
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // nginx (and the nginx ingress) buffer proxied responses unless told not to.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(EVENT_STREAM_OPENING);
}
