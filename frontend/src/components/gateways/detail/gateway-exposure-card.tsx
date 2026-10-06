/**
 * How a tool gateway shows its tools to the apps that connect to it (code
 * mode, docs/design/code-mode.md part E): every tool, or a search box and
 * scripts, or both. Scripts are off unless the server allows them and the
 * gateway asks callers to sign in; the card says which, in plain words.
 */
import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScriptChanges } from '@/components/agents/builder/capabilities-section'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'

export type GatewayExposure = 'tools' | 'code' | 'both'

const LABEL: Record<GatewayExposure, string> = {
  tools: 'Every tool',
  code: 'Search, and write scripts',
  both: 'Every tool, plus search and scripts',
}

const HINT: Record<GatewayExposure, string> = {
  tools: 'Apps see every tool, in full, and call them one at a time. Best for a handful of tools.',
  code: 'Apps see three tools: one to search, one to read a tool, and one to run a short script that calls the tools. Best for many tools and multi-step jobs.',
  both: 'Apps see every tool, and also the search and script tools.',
}

export interface GatewayExposureCardProps {
  gateway: {
    id: string
    type: string
    configuration?: Record<string, any> | null
    codeMode?: { serverAllows: boolean; hasAuth: boolean; exposure: GatewayExposure }
  }
}

/** Why scripts cannot be chosen here, or null when they can. */
export function scriptsBlockedReason(codeMode: GatewayExposureCardProps['gateway']['codeMode']): string | null {
  if (!codeMode?.serverAllows) return 'Scripts on gateways are turned off on this server. Your administrator can turn them on.'
  if (!codeMode.hasAuth) return 'Scripts need callers to sign in. Add an authentication method to this gateway first.'
  return null
}

export function GatewayExposureCard({ gateway }: GatewayExposureCardProps) {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  const configuration = gateway.configuration ?? {}
  const wanted: GatewayExposure = configuration.exposure === 'code' || configuration.exposure === 'both' ? configuration.exposure : 'tools'
  const blocked = scriptsBlockedReason(gateway.codeMode)
  const options: GatewayExposure[] = gateway.type === 'skills' ? ['tools', 'code'] : ['tools', 'code', 'both']

  const save = useMutation({
    mutationFn: (patch: Record<string, any>) => gatewaysApi.update(gateway.id, { configuration: { ...configuration, ...patch } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway', gateway.id] })
      success('Saved', 'How this gateway shows its tools is updated.')
    },
    onError: (err) => error('Could not save', getApiErrorMessage(err)),
  })

  return (
    <Card data-testid="gateway-exposure-card">
      <CardHeader>
        <CardTitle>How apps see the tools</CardTitle>
        <CardDescription>What an app connected to this gateway is shown, and whether it can run scripts here.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="gateway-exposure">Show</Label>
          <Select
            value={wanted}
            onValueChange={(v) => save.mutate({ exposure: v as GatewayExposure })}
            disabled={save.isPending}
          >
            <SelectTrigger id="gateway-exposure" aria-label="How apps see the tools" className="sm:max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o} value={o} disabled={o !== 'tools' && !!blocked}>
                  {LABEL[o]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{HINT[wanted]}</p>
          {blocked && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="exposure-blocked">
              {blocked}
            </p>
          )}
        </div>
        {wanted !== 'tools' && !blocked && (
          <ScriptChanges
            agentConfig={{ codeMode: configuration.codeMode } as any}
            onChange={(patch) => save.mutate({ codeMode: (patch as any).codeMode })}
          />
        )}
      </CardContent>
    </Card>
  )
}
