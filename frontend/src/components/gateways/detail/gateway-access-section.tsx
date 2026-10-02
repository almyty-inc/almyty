import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AccessScopeField, type AccessScope, type AccessScopeValue } from '@/components/ui/access-scope-field'
import { GatewayAuthSection } from './gateway-auth-section'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useOrganizationStore } from '@/store/organization'
import { useOrganizationRole } from '@/hooks/use-organization-role'

export function GatewayAccessSection({ gateway }: { gateway: { id: string; name: string; accessScope?: AccessScope; accessTeamId?: string | null; configuration?: Record<string, any> } }) {
  const { currentOrganization } = useOrganizationStore()
  const queryClient = useQueryClient()
  const { canManage } = useOrganizationRole()
  const stored = gateway.accessScope ?? 'org'
  const [value, setValue] = useState<AccessScopeValue>({ accessScope: stored, teamId: gateway.accessTeamId ?? null })
  useEffect(() => setValue({ accessScope: gateway.accessScope ?? 'org', teamId: gateway.accessTeamId ?? null }), [gateway.id, gateway.accessScope, gateway.accessTeamId])
  const save = useMutation({
    mutationFn: () => gatewaysApi.update(gateway.id, { accessScope: value.accessScope, accessTeamId: value.teamId,
      ...(value.accessScope === 'external_open' ? { configuration: { ...gateway.configuration, exposure: 'tools' } } : {}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['gateway', gateway.id] }),
  })
  const dirty = value.accessScope !== stored || value.teamId !== (gateway.accessTeamId ?? null)
  return <Card data-testid="gateway-access-section">
    <CardHeader><CardTitle>Who can use it</CardTitle><CardDescription>Access to this gateway's endpoint.</CardDescription></CardHeader>
    <CardContent className="space-y-5">
      <AccessScopeField organizationId={currentOrganization?.id ?? ''} value={value} onChange={setValue} disabled={!canManage || save.isPending} />
      {dirty && canManage && <Button type="button" size="sm" disabled={save.isPending || (value.accessScope === 'team' && !value.teamId)} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save access'}</Button>}
      {save.isError && <p role="alert" className="text-sm text-destructive">{getApiErrorMessage(save.error, 'Access could not be saved.')}</p>}
      {value.accessScope === 'external_protected' && stored === 'external_protected' && <GatewayAuthSection gatewayId={gateway.id} gatewayName={gateway.name} readOnly={!canManage} />}
      {value.accessScope === 'external_protected' && stored !== 'external_protected' && <p className="text-sm text-muted-foreground">Save this access choice to set up sign-in methods.</p>}
    </CardContent>
  </Card>
}
