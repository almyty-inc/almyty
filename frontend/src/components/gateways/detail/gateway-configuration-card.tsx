/**
 * GatewayConfigurationCard — type-aware endpoint/install command card.
 *
 * Renders the primary endpoint URL (or skills install command) for a gateway
 * with a copy button. Used at the top of GatewayDetailPage as the first card
 * after the header.
 */
import React from 'react'
import { Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export interface GatewayConfigurationCardProps {
  gateway: any
  orgSlug: string
  onCopySuccess: (title: string, message: string) => void
  onCopyError: (title: string, message: string) => void
}

function buildEndpoint(gateway: any, orgSlug: string): string {
  const backendUrl = import.meta.env.VITE_API_BASE_URL || window.location.origin
  const gwSlug = gateway.endpoint?.replace(/^\//, '') || ''
  if (gateway.type === 'mcp') return `${backendUrl}/mcp/${orgSlug}/${gwSlug}`
  if (gateway.type === 'utcp') return `${backendUrl}/${orgSlug}/${gwSlug}`
  if (gateway.type === 'a2a') return `${backendUrl}/${orgSlug}/${gwSlug}`
  if (gateway.type === 'skills') {
    const nameSlug = (gateway.name || '').toLowerCase().replace(/\s+/g, '-')
    return `npx @almyty/skills install @${orgSlug}/${nameSlug}`
  }
  return gateway.endpoint
}

export function GatewayConfigurationCard({
  gateway,
  orgSlug,
  onCopySuccess,
  onCopyError,
}: GatewayConfigurationCardProps) {
  const endpointDisplay = buildEndpoint(gateway, orgSlug)

  const handleCopy = async () => {
    const fullEndpoint = buildEndpoint(gateway, orgSlug)
    try {
      await navigator.clipboard.writeText(fullEndpoint)
      onCopySuccess('Copied!', 'Endpoint copied to clipboard')
    } catch (err) {
      onCopyError('Failed to copy', 'Could not copy to clipboard')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
        <CardDescription>
          {gateway.type === 'skills' ? 'Install command and setup' : 'Gateway endpoint and connection details'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground mb-2">
              {gateway.type === 'mcp' && 'Endpoint URL'}
              {gateway.type === 'utcp' && 'Endpoint URL'}
              {gateway.type === 'a2a' && 'Endpoint URL'}
              {gateway.type === 'skills' && 'Install Command'}
            </p>
            <div className="flex gap-2">
              <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">
                {endpointDisplay}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCopy}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
