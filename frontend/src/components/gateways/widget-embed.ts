/** Embed snippet for the chat widget. Served by GET /gateways/:id/widget.js. */
export function buildWidgetEmbedSnippet(apiHost: string, gatewayId: string): string {
  return `<script src="${apiHost.replace(/\/+$/, '')}/gateways/${gatewayId}/widget.js" async></script>`
}
