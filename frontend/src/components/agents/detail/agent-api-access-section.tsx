import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { AccessScopeField, type AccessScopeValue } from '@/components/ui/access-scope-field'
import { GatewayAuthSection } from '@/components/gateways/detail/gateway-auth-section'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useOrganizationStore } from '@/store/organization'
import { useCanManageAgent } from '@/hooks/use-organization-role'

export function AgentApiAccessSection({ agentId, ownerUserId }: { agentId: string; ownerUserId?: string }) {
  const { currentOrganization } = useOrganizationStore()
  const queryClient = useQueryClient()
  const canManage = useCanManageAgent(ownerUserId)
  const key = ['agent-api-access', agentId]
  const access = useQuery({ queryKey: key, queryFn: () => agentsApi.getApiAccess(agentId) })
  const stored = access.data?.accessScope ?? 'org'
  const storedTeam = access.data?.accessTeamId ?? null
  const [value, setValue] = useState<AccessScopeValue>({ accessScope: stored, teamId: storedTeam })
  useEffect(() => setValue({ accessScope: stored, teamId: storedTeam }), [agentId, stored, storedTeam])
  const save = useMutation({
    mutationFn: () => agentsApi.setApiAccess(agentId, { accessScope: value.accessScope, accessTeamId: value.teamId }),
    onSuccess: result => { queryClient.setQueryData(key, result); queryClient.invalidateQueries({ queryKey: ['agent', agentId] }) },
  })
  const dirty = value.accessScope !== stored || value.teamId !== storedTeam
  return <Card data-testid="agent-api-access-section">
    <CardHeader><CardTitle>API access</CardTitle><CardDescription>Who can call this agent from an app or another system.</CardDescription></CardHeader>
    <CardContent className="space-y-5">
      {access.isError ? <p role="alert" className="text-sm text-destructive">API access could not be loaded. Reload to try again.</p> : <>
        <AccessScopeField organizationId={currentOrganization?.id ?? ''} value={value} onChange={setValue} disabled={!canManage || access.isLoading || save.isPending} />
        {dirty && canManage && <Button type="button" size="sm" disabled={save.isPending || (value.accessScope === 'team' && !value.teamId)} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save API access'}</Button>}
        {save.isError && <p role="alert" className="text-sm text-destructive">{getApiErrorMessage(save.error, 'API access could not be saved.')}</p>}
        {access.data?.endpoint && <CopyField value={access.data.endpoint} label="Endpoint" />}
        {value.accessScope === 'external_protected' && stored === 'external_protected' && access.data?.gatewayId && <GatewayAuthSection gatewayId={access.data.gatewayId} readOnly={!canManage} />}
        {value.accessScope === 'external_protected' && stored !== 'external_protected' && <p className="text-sm text-muted-foreground">Save this access choice to set up sign-in methods.</p>}
      </>}
    </CardContent>
  </Card>
}
