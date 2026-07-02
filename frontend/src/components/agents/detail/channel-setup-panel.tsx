/**
 * Post-deploy setup panel for a deployed channel (agent-kind gateway).
 *
 * Shows everything the user needs to finish wiring the channel on the
 * platform's side: the inbound webhook URL on the unified endpoint, a
 * per-platform checklist, the widget embed snippet where relevant, and a
 * live connection test against POST /gateways/:id/test-connection.
 */
import React from 'react'
import { useMutation } from '@tanstack/react-query'
import { Copy, Loader2, PlugZap } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { gatewaysApi, getApiBaseUrl } from '@/lib/api'
import { useCopy } from '@/lib/clipboard'
import { useOrganizationStore } from '@/store/organization'
import type { Gateway } from '@/types'
import {
  CHANNEL_SETUP_GUIDES,
  buildChannelWebhookUrl,
  buildWidgetEmbedSnippet,
  getGatewaySlug,
} from './channel-setup'

interface ChannelSetupPanelProps {
  gateway: Gateway
}

interface TestConnectionResult {
  ok: boolean
  detail?: string
}

export function ChannelSetupPanel({ gateway }: ChannelSetupPanelProps) {
  const { currentOrganization } = useOrganizationStore()
  const copy = useCopy()

  const apiHost = getApiBaseUrl()
  const orgSlug =
    currentOrganization?.slug ||
    currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') ||
    'org'
  const webhookUrl = buildChannelWebhookUrl(apiHost, orgSlug, getGatewaySlug(gateway))
  const guide = CHANNEL_SETUP_GUIDES[gateway.type]
  const widgetSnippet =
    gateway.type === 'chat_widget' ? buildWidgetEmbedSnippet(apiHost, gateway.id) : null

  const testMutation = useMutation<TestConnectionResult>({
    mutationFn: async () => {
      const res: any = await gatewaysApi.testChannelConnection(gateway.id)
      return { ok: !!res?.ok, detail: res?.detail }
    },
  })
  const testResult = testMutation.isError
    ? { ok: false, detail: 'Test request failed' }
    : testMutation.data

  return (
    <div className="space-y-4" data-testid="channel-setup-panel">
      {/* Webhook URL */}
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
          {guide?.webhookMode === 'none' ? 'Endpoint URL' : 'Webhook URL'}
        </div>
        <div className="flex items-center gap-1">
          <code className="text-[11px] break-all flex-1" data-testid="channel-webhook-url">
            {webhookUrl}
          </code>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            aria-label="Copy webhook URL"
            onClick={() => copy(webhookUrl, 'Webhook URL')}
          >
            <Copy className="h-3 w-3" />
          </Button>
        </div>
        {guide?.webhookMode === 'auto' && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Registered automatically where the platform supports it.
          </p>
        )}
      </div>

      {/* Widget embed snippet */}
      {widgetSnippet && (
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Embed snippet
          </div>
          <div className="flex items-center gap-1">
            <code className="text-[11px] break-all flex-1" data-testid="widget-embed-snippet">
              {widgetSnippet}
            </code>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              aria-label="Copy embed snippet"
              onClick={() => copy(widgetSnippet, 'Embed snippet')}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}

      {/* Platform-side checklist */}
      {guide && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            {guide.title}
          </p>
          <ol className="list-decimal space-y-1.5 pl-4 text-xs text-muted-foreground">
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Connection test */}
      <div className="flex items-center gap-2 border-t pt-3">
        <Button
          variant="outline"
          size="sm"
          disabled={testMutation.isPending}
          onClick={() => testMutation.mutate()}
        >
          {testMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <PlugZap className="h-3.5 w-3.5 mr-1.5" />
          )}
          Test connection
        </Button>
        {testResult && (
          <Badge variant={testResult.ok ? 'success' : 'destructive'} data-testid="test-connection-result">
            {testResult.ok ? 'Connected' : 'Failed'}
          </Badge>
        )}
        {testResult?.detail && (
          <span className="text-xs text-muted-foreground truncate">{testResult.detail}</span>
        )}
      </div>
    </div>
  )
}
