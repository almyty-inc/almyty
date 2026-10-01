import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toolsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'

export type SideEffect = 'read' | 'write' | 'destructive'
export type SideEffectSource = 'override' | 'annotation' | 'http_method' | 'graphql' | 'default'

/** What a tool does to data, in the words the page uses. */
export const SIDE_EFFECT_LABEL: Record<SideEffect, string> = {
  read: 'Only reads',
  write: 'Changes data',
  destructive: 'Deletes data',
}

const SIDE_EFFECT_BADGE: Record<SideEffect, 'outline' | 'secondary' | 'destructive'> = {
  read: 'outline',
  write: 'secondary',
  destructive: 'destructive',
}

/** Why the tool has the class it has, in plain words. */
export function sideEffectReason(tool: {
  sideEffect?: SideEffect
  sideEffectSource?: SideEffectSource
  executionMethod?: string | null
  httpConfig?: { method?: string } | null
  operation?: { method?: string } | null
  metadata?: Record<string, any>
}): string {
  const method = (tool.operation?.method ?? tool.metadata?.sourceOperation?.method ?? tool.httpConfig?.method ?? '').toUpperCase()
  switch (tool.sideEffectSource) {
    case 'override':
      return 'Set by a person on this page.'
    case 'annotation':
      return 'Said by the MCP server the tool comes from.'
    case 'http_method':
      return method ? `From its HTTP method, ${method}.` : 'From its HTTP method.'
    case 'graphql':
      return tool.sideEffect === 'read' ? 'It is a GraphQL query.' : 'It is a GraphQL mutation.'
    default:
      return tool.executionMethod === 'llm'
        ? 'It only asks a model, so it changes nothing.'
        : 'Nothing about the tool says for sure, so it is treated as changing data.'
  }
}

interface SideEffectCardProps {
  tool: {
    id: string
    sideEffect?: SideEffect
    sideEffectSource?: SideEffectSource
    openWorld?: boolean
    executionMethod?: string | null
    httpConfig?: { method?: string } | null
    operation?: { method?: string } | null
    metadata?: Record<string, any>
  }
  organizationId: string
  canEdit: boolean
}

/**
 * What calling the tool does to data (read, write, destructive), why, and
 * a way for a person to set it. Agents that write code against your tools
 * hold deleting calls for approval, and apps read it as a hint.
 */
export function SideEffectCard({ tool, organizationId, canEdit }: SideEffectCardProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const sideEffect: SideEffect = tool.sideEffect ?? 'write'
  const overridden = tool.sideEffectSource === 'override'

  const save = useMutation({
    mutationFn: (value: SideEffect | 'auto') => toolsApi.update(tool.id, { sideEffect: value }, organizationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tool', tool.id] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
    },
    onError: (err) => notifications.error('Could not save', getApiErrorMessage(err)),
  })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">What it does to your data</CardTitle>
        <CardDescription className="text-xs">
          Calls that delete data wait for a person when an agent works through code, and apps use this as a hint.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <Badge variant={SIDE_EFFECT_BADGE[sideEffect]} data-testid="side-effect-badge">
            {SIDE_EFFECT_LABEL[sideEffect]}
          </Badge>
          <span className="text-muted-foreground">
            {tool.openWorld === false ? 'Stays inside almyty' : 'Reaches an outside service'}
          </span>
        </div>
        <p className="text-muted-foreground" data-testid="side-effect-reason">{sideEffectReason(tool)}</p>
        {canEdit && (
          <div className="space-y-1">
            <Label htmlFor="tool-side-effect">Set it yourself</Label>
            <Select
              value={overridden ? sideEffect : 'auto'}
              onValueChange={(value) => save.mutate(value as SideEffect | 'auto')}
              disabled={save.isPending}
            >
              <SelectTrigger id="tool-side-effect" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic</SelectItem>
                <SelectItem value="read">{SIDE_EFFECT_LABEL.read}</SelectItem>
                <SelectItem value="write">{SIDE_EFFECT_LABEL.write}</SelectItem>
                <SelectItem value="destructive">{SIDE_EFFECT_LABEL.destructive}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
