/**
 * GatewayToolsTab — tool scoping UI for the gateway detail page.
 *
 * Renders quick scoping presets (read-only / admin / public / all / remove all)
 * and the per-tool assign/remove + per-tool security policy entry point.
 * Tools are grouped by source API with collapsible sections, search, and
 * select-all per group.
 *
 * Used as the "Tool Scoping" tab inside GatewayDetailPage.
 */
import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Search, Shield, Zap } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { toolSourceApi, DELETED_API_LABEL } from '@/lib/tool-source'

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

interface ToolGroup {
  apiId: string
  apiName: string
  tools: any[]
  assignedCount: number
}

/**
 * Whether a gateway can be given this tool at all.
 *
 * GatewayToolService refuses anything that is not active, and every tool
 * generated from a schema starts as a draft — so without this the picker
 * offered Assign on tools it knew would be refused.
 */
function isToolAssignable(tool: any): boolean {
  return !tool.status || tool.status === 'active'
}

function getToolApiKey(tool: any): string {
  return toolSourceApi(tool).id || '__custom__'
}

function getToolApiName(tool: any): string {
  return toolSourceApi(tool).name || (tool.type === 'api' ? DELETED_API_LABEL : 'Custom Tools')
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
  const [search, setSearch] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const isToolAssigned = useMemo(() => {
    const set = new Set<string>()
    for (const gt of gatewayTools) {
      if (gt.toolId) set.add(gt.toolId)
      if (gt.tool?.id) set.add(gt.tool.id)
    }
    return (toolId: string) => set.has(toolId)
  }, [gatewayTools])

  const groups: ToolGroup[] = useMemo(() => {
    const lowerSearch = search.toLowerCase()

    // Filter tools by search
    const filtered = lowerSearch
      ? allTools.filter(
          (t: any) =>
            (t.name || '').toLowerCase().includes(lowerSearch) ||
            (t.description || '').toLowerCase().includes(lowerSearch),
        )
      : allTools

    // Group by API
    const map = new Map<string, ToolGroup>()
    for (const tool of filtered) {
      const key = getToolApiKey(tool)
      let group = map.get(key)
      if (!group) {
        group = { apiId: key, apiName: getToolApiName(tool), tools: [], assignedCount: 0 }
        map.set(key, group)
      }
      group.tools.push(tool)
      if (isToolAssigned(tool.id)) group.assignedCount++
    }

    // Sort: groups with assigned tools first, then alphabetically
    return Array.from(map.values()).sort((a, b) => {
      if (a.assignedCount > 0 && b.assignedCount === 0) return -1
      if (a.assignedCount === 0 && b.assignedCount > 0) return 1
      return a.apiName.localeCompare(b.apiName)
    })
  }, [allTools, gatewayTools, search, isToolAssigned])

  const toggleGroup = (apiId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(apiId)) next.delete(apiId)
      else next.add(apiId)
      return next
    })
  }

  const handleSelectAll = (group: ToolGroup) => {
    const assignable = group.tools.filter(isToolAssignable)
    const allAssigned =
      assignable.length > 0 && assignable.every((tool) => isToolAssigned(tool.id))
    if (allAssigned) {
      for (const tool of group.tools) {
        if (isToolAssigned(tool.id)) onRemove(tool.id)
      }
    } else {
      // Only the assignable ones: select-all used to fire an Assign for
      // every draft in the group, each of which came back a 400.
      for (const tool of assignable) {
        if (!isToolAssigned(tool.id)) onAssign(tool.id)
      }
    }
  }

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
        <div className="space-y-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tools by name or description..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No tools match your search.
            </p>
          ) : (
            groups.map((group) => {
              const isExpanded = expandedGroups.has(group.apiId)
              const allAssigned = group.assignedCount === group.tools.length
              const someAssigned = group.assignedCount > 0 && !allAssigned

              return (
                <Card key={group.apiId}>
                  {/* Group header */}
                  <button
                    type="button"
                    className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/50 transition-colors"
                    onClick={() => toggleGroup(group.apiId)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div
                      className="shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={allAssigned ? true : someAssigned ? 'indeterminate' : false}
                        onCheckedChange={() => handleSelectAll(group)}
                        disabled={assignPending || removePending}
                        aria-label={`Select all tools from ${group.apiName}`}
                      />
                    </div>
                    <span className="font-medium flex-1 truncate">{group.apiName}</span>
                    <Badge variant="secondary" className="shrink-0">
                      {group.assignedCount} of {group.tools.length} assigned
                    </Badge>
                  </button>

                  {/* Expanded tool list */}
                  {isExpanded && (
                    <div className="border-t">
                      {group.tools.map((tool: any) => {
                        const assigned = isToolAssigned(tool.id)
                        const assignable = isToolAssignable(tool)

                        return (
                          <div
                            key={tool.id}
                            className="flex items-center justify-between px-4 py-3 border-b last:border-b-0"
                          >
                            <div className="flex-1 min-w-0 pl-7">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm">{tool.name}</span>
                                {/*
                                  Badged, not hidden.

                                  This list had no status filter at all, so
                                  it offered Assign on tools the gateway was
                                  always going to refuse -- and right after a
                                  schema import that is every tool, since
                                  generated tools are drafts. Filtering them
                                  out would have been worse: the user would
                                  see an empty picker moments after being
                                  told their tools were created, with nothing
                                  to explain the gap. So show them, say what
                                  state they are in, and say where it is
                                  fixed.
                                */}
                                {!assignable && (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 border-amber-400/50 text-amber-600 dark:text-amber-400"
                                  >
                                    {tool.status === 'draft' ? 'Draft' : tool.status}
                                  </Badge>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">
                                {(tool.description || 'No description').replace(
                                  /^Auto-generated tool for\s+/i,
                                  '',
                                )}
                              </div>
                              {tool.method && (
                                <Badge variant="outline" className="mt-1 text-xs">
                                  {tool.method}
                                </Badge>
                              )}
                            </div>
                            <div className="flex gap-2 shrink-0">
                              {assigned && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  aria-label={`Configure security policy for ${tool.name}`}
                                  onClick={() => {
                                    const gt = gatewayTools.find(
                                      (gt: any) => gt.toolId === tool.id || gt.tool?.id === tool.id,
                                    )
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
                                variant={assigned ? 'destructive' : 'default'}
                                size="sm"
                                onClick={() => {
                                  if (assigned) onRemove(tool.id)
                                  else onAssign(tool.id)
                                }}
                                disabled={
                                  assignPending || removePending || (!assigned && !assignable)
                                }
                                title={
                                  !assigned && !assignable
                                    ? `This tool is ${tool.status}. Activate it on the Tools page — select it there and use "Activate selected" — then assign it here.`
                                    : undefined
                                }
                              >
                                {assigned ? 'Remove' : 'Assign'}
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </Card>
              )
            })
          )}
        </div>
      )}
    </>
  )
}
