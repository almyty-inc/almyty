/**
 * `subscriptions/listen` (MCP 2026-07-28, "Subscriptions"): one long-lived
 * SSE response per listen request, carrying only the change notifications
 * the client opted in to.
 *
 *  - The first message is `notifications/subscriptions/acknowledged` with the
 *    subset of the requested filter this server honours. Here that is
 *    `toolsListChanged`, on a surface whose tool set can change (a tenant
 *    gateway). Prompt and resource list changes are not tracked and are left
 *    out of the acknowledgment, as the spec asks.
 *  - Every message carries `_meta["io.modelcontextprotocol/subscriptionId"]`,
 *    the JSON-RPC id of the listen request.
 *  - Changes arrive from McpChangeBus, so a change made on any pod reaches
 *    the pod holding this stream.
 *  - A keep-alive comment every MCP_LISTEN_KEEPALIVE_MS keeps proxies from
 *    closing a quiet stream; after MCP_LISTEN_MAX_SECONDS the server ends the
 *    subscription gracefully with a `complete` result and the client listens
 *    again. A client ends it by closing the stream.
 */
import type { Response } from 'express';

import type { McpChangeBus } from '../../mcp-events/mcp-change-bus.service';
import { McpServerInfo, SERVER_INFO_META } from './mcp-protocol-core';
import { mcpProtocolSettings } from './mcp-settings';

export const SUBSCRIPTION_ID_META = 'io.modelcontextprotocol/subscriptionId';

export interface ListenOptions {
  res: Response;
  /** The listen request's JSON-RPC id, which is the subscription id. */
  id: string | number;
  params: any;
  serverInfo: McpServerInfo;
  /** The gateway whose tool-set changes this surface can report, or null. */
  toolsGatewayId: string | null;
  bus?: McpChangeBus;
}

export interface AcknowledgedFilter {
  toolsListChanged?: true;
}

/** The subset of a requested filter this server honours. */
export function acknowledgedFilter(requested: unknown, canReportTools: boolean): AcknowledgedFilter {
  const filter = requested && typeof requested === 'object' ? (requested as Record<string, unknown>) : {};
  return canReportTools && filter.toolsListChanged === true ? { toolsListChanged: true } : {};
}

function frame(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

/** Open the stream. Resolves once it is set up; the stream lives on until closed. */
export function serveSubscriptionListen(opts: ListenOptions): void {
  const { res, id, serverInfo } = opts;
  const settings = mcpProtocolSettings();
  const canReportTools = !!(opts.toolsGatewayId && opts.bus);
  const acknowledged = acknowledgedFilter(opts.params?.notifications, canReportTools);
  const meta = { [SUBSCRIPTION_ID_META]: id };

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  // no-transform keeps compression from buffering the stream; X-Accel
  // tells nginx not to (the spec's SHOULD for SSE responses).
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let open = true;
  const write = (chunk: string) => {
    if (!open || res.destroyed) return;
    try {
      res.write(chunk);
    } catch {
      close();
    }
  };

  write(
    frame({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { _meta: meta, notifications: acknowledged },
    }),
  );

  const unsubscribe =
    acknowledged.toolsListChanged && opts.bus && opts.toolsGatewayId
      ? opts.bus.onGatewayToolsChanged(opts.toolsGatewayId, () =>
          write(frame({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: meta } })),
        )
      : () => undefined;

  const keepAlive = setInterval(() => write(': keep-alive\n\n'), settings.listenKeepaliveMs);
  keepAlive.unref?.();

  // Graceful closure: the JSON-RPC response to the listen request.
  const lifetime = setTimeout(() => {
    write(
      frame({
        jsonrpc: '2.0',
        id,
        result: { resultType: 'complete', _meta: { ...meta, [SERVER_INFO_META]: serverInfo } },
      }),
    );
    close();
    try {
      res.end();
    } catch {
      /* already gone */
    }
  }, settings.listenMaxSeconds * 1000);
  lifetime.unref?.();

  function close() {
    if (!open) return;
    open = false;
    clearInterval(keepAlive);
    clearTimeout(lifetime);
    unsubscribe();
  }

  res.on('close', close);
}
