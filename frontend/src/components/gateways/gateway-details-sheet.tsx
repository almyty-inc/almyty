import React from 'react'
import { Search } from 'lucide-react'
import { UseMutationResult } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import type { Gateway } from '@/types'

interface GatewayDetailsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedGateway: Gateway | null
  allTools: any[]
  assignedToolIds: Set<string>
  assignToolMutation: UseMutationResult<any, any, any, any>
  removeToolMutation: UseMutationResult<any, any, any, any>
  toolSearch: string
  onToolSearchChange: (value: string) => void
  toolFilter: 'all' | 'assigned' | 'unassigned'
  onToolFilterChange: (value: 'all' | 'assigned' | 'unassigned') => void
}

export function GatewayDetailsSheet({
  open,
  onOpenChange,
  selectedGateway,
  allTools,
  assignedToolIds,
  assignToolMutation,
  removeToolMutation,
  toolSearch,
  onToolSearchChange,
  toolFilter,
  onToolFilterChange,
}: GatewayDetailsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{selectedGateway?.name || 'Gateway Details'}</SheetTitle>
          <SheetDescription>{selectedGateway?.description}</SheetDescription>
        </SheetHeader>
        <div className="mt-6">
          <Tabs defaultValue="info">
            <TabsList className={`grid w-full ${selectedGateway?.isSystem ? 'grid-cols-1' : 'grid-cols-2'}`}>
              <TabsTrigger value="info">Information</TabsTrigger>
              {!selectedGateway?.isSystem && (
                <TabsTrigger value="tools">Tools</TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="info" className="space-y-4 mt-4">
              <div>
                <h3 className="font-semibold mb-2">Gateway Configuration</h3>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Type:</span>
                    <span className="font-medium">{selectedGateway?.type?.toUpperCase()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Endpoint:</span>
                    <span className="font-mono text-sm">{selectedGateway?.endpoint}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Status:</span>
                    <span>{selectedGateway?.status}</span>
                  </div>
                </div>
              </div>
            </TabsContent>
            {!selectedGateway?.isSystem && (
            <TabsContent value="tools" className="space-y-4 mt-4">
              <div>
                <h3 className="font-semibold mb-2">Tool Scoping</h3>
                <p className="text-sm text-muted-foreground mb-2">
                  {assignedToolIds.size} of {allTools.length} tools assigned
                </p>
                <div className="flex items-center gap-2 mb-3">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search tools..."
                      value={toolSearch}
                      onChange={(e) => onToolSearchChange(e.target.value)}
                      className="pl-8 h-9"
                    />
                  </div>
                  <Select value={toolFilter} onValueChange={(v) => onToolFilterChange(v as 'all' | 'assigned' | 'unassigned')}>
                    <SelectTrigger className="w-[130px] h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="assigned">Assigned</SelectItem>
                      <SelectItem value="unassigned">Unassigned</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 max-h-[350px] overflow-y-auto">
                  {(() => {
                    const filtered = allTools.filter((tool: any) => {
                      const isAssigned = assignedToolIds.has(tool.id)
                      const matchesSearch = !toolSearch || tool.name.toLowerCase().includes(toolSearch.toLowerCase()) || (tool.description || '').toLowerCase().includes(toolSearch.toLowerCase())
                      const matchesFilter = toolFilter === 'all' || (toolFilter === 'assigned' && isAssigned) || (toolFilter === 'unassigned' && !isAssigned)
                      return matchesSearch && matchesFilter
                    })
                    if (filtered.length === 0) {
                      return <p className="text-sm text-muted-foreground text-center py-4">{allTools.length === 0 ? 'No tools available. Create tools first.' : 'No tools match your filter.'}</p>
                    }
                    return filtered.map((tool: any) => {
                      const isAssigned = assignedToolIds.has(tool.id)
                      return (
                        <div key={tool.id} className={`flex items-center justify-between py-2 px-3 rounded-md border ${isAssigned ? 'border-primary/30 bg-primary/5' : ''}`}>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-sm truncate">{tool.name}</div>
                            {tool.description && (
                              <div className="text-xs text-muted-foreground truncate">{tool.description}</div>
                            )}
                          </div>
                          <Button
                            variant={isAssigned ? 'destructive' : 'outline'}
                            size="sm"
                            className="ml-2 shrink-0"
                            disabled={assignToolMutation.isPending || removeToolMutation.isPending}
                            onClick={() => {
                              if (isAssigned) {
                                removeToolMutation.mutate(tool.id)
                              } else {
                                assignToolMutation.mutate(tool.id)
                              }
                            }}
                          >
                            {isAssigned ? 'Remove' : 'Assign'}
                          </Button>
                        </div>
                      )
                    })
                  })()}
                </div>
              </div>
            </TabsContent>
            )}
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  )
}
