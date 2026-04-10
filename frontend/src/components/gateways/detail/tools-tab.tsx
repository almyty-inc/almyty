/**
 * GatewayToolsTab — tool scoping UI for the gateway detail page.
 *
 * Renders quick scoping presets (read-only / admin / public / all / remove all)
 * and the per-tool assign/remove + per-tool security policy entry point.
 * Used as the "Tool Scoping" tab inside GatewayDetailPage.
 */
import React from 'react'
import { Shield, Zap } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

export type ScopingPreset = 'read-only' | 'admin' | 'public' | 'all' | 'none'

export interface SecurityTarget {
  gatewayToolId: string
  toolName: string
  policy: any
}

export interface GatewayToolsTabProps {
  gatewayTools: any[]
  allTools: any[]
  isLoadingGatewayTools: boolean
  isLoadingAllTools: boolean
  bulkAssignPending: boolean
  assignPending: boolean
  removePending: boolean
  onApplyPreset: (preset: ScopingPreset) => void
  onRequestRemoveAll: () => void
  onAssign: (toolId: string) => void
  onRemove: (toolId: string) => void
  onOpenSecurity: (target: SecurityTarget) => void
}

export function GatewayToolsTab({
  gatewayTools,
  allTools,
  isLoadingGatewayTools,
  isLoadingAllTools,
  bulkAssignPending,
  assignPending,
  removePending,
  onApplyPreset,
  onRequestRemoveAll,
  onAssign,
  onRemove,
  onOpenSecurity,
}: GatewayToolsTabProps) {
  return (
    <>
      {/* Scoping Status */}
      <Card>
        <CardHeader>
          <CardTitle>Tool Scoping</CardTitle>
          <CardDescription>
            Control which tools are available through this gateway. {gatewayTools.length} of {allTools.length} assigned
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onApplyPreset('read-only')}
              disabled={bulkAssignPending}
            >
              Read Only
            </Button>
            <Button
              variant="outline"
              onClick={() => onApplyPreset('admin')}
              disabled={bulkAssignPending}
            >
              Admin Tools
            </Button>
            <Button
              variant="outline"
              onClick={() => onApplyPreset('public')}
              disabled={bulkAssignPending}
            >
              Public API
            </Button>
            <Button
              variant="outline"
              onClick={() => onApplyPreset('all')}
              disabled={bulkAssignPending}
            >
              All Tools
            </Button>
            <Button
              variant="outline"
              onClick={onRequestRemoveAll}
              disabled={bulkAssignPending}
            >
              Remove All
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Available Tools */}
      {isLoadingGatewayTools || isLoadingAllTools ? (
        <div className="flex items-center justify-center h-64">
          <LoadingSpinner size="lg" />
        </div>
      ) : allTools.length === 0 ? (
        <Card>
          <CardContent className="text-center py-8">
            <Zap className="h-12 w-12 text-muted-foreground mx-auto mb-2" />
            <p className="text-muted-foreground">
              No tools available. Create some tools from your APIs first.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {allTools.map((tool: any) => {
            const isAssigned = gatewayTools.some((gt: any) => gt.toolId === tool.id || gt.tool?.id === tool.id)

            return (
              <Card key={tool.id}>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex-1">
                    <div className="font-medium">{tool.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {(tool.description || 'No description').replace(/^Auto-generated tool for\s+/i, '')}
                    </div>
                    {tool.method && (
                      <Badge variant="outline" className="mt-1">
                        {tool.method}
                      </Badge>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {isAssigned && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const gt = gatewayTools.find((gt: any) => gt.toolId === tool.id || gt.tool?.id === tool.id)
                          onOpenSecurity({
                            gatewayToolId: gt?.gatewayToolId || gt?.id || tool.id,
                            toolName: tool.name,
                            policy: gt?.securityPolicy || null,
                          })
                        }}
                      >
                        <Shield className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant={isAssigned ? 'destructive' : 'default'}
                      size="sm"
                      onClick={() => {
                        if (isAssigned) {
                          onRemove(tool.id)
                        } else {
                          onAssign(tool.id)
                        }
                      }}
                      disabled={assignPending || removePending}
                    >
                      {isAssigned ? 'Remove' : 'Assign'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}
