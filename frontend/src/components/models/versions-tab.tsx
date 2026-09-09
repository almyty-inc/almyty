import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { QueryError } from '@/components/ui/query-error'
import { holdsVersion, modelAdaptersApi, modelDeploymentsApi, modelVersionsApi } from '@/lib/deployments-api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { CreateModelDeploymentBody, ModelAdapter, ModelDeployment, ModelVersion, RegisterModelVersionBody } from '@/types/deployments'
import { DeployDialog } from './deployments/deploy-dialog'
import { RegisterVersionDialog } from './versions/register-version-dialog'
import { VersionDetailSheet } from './versions/version-detail-sheet'
import { VersionsList } from './versions/versions-list'

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { message?: string } }; message?: string }
  return e?.response?.data?.message ?? e?.message ?? fallback
}

export function VersionsTab() {
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id
  const qc = useQueryClient()
  const notify = useNotifications()
  const [registerOpen, setRegisterOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deployVersionId, setDeployVersionId] = useState<string | null>(null)

  const versionsQuery = useQuery<ModelVersion[]>({
    queryKey: ['model-versions', orgId],
    queryFn: async () => {
      const d = await modelVersionsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!orgId,
  })
  const deploymentsQuery = useQuery<ModelDeployment[]>({
    queryKey: ['model-deployments', orgId],
    queryFn: async () => {
      const d = await modelDeploymentsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!orgId,
  })
  const adaptersQuery = useQuery<ModelAdapter[]>({
    queryKey: ['model-adapters', orgId],
    queryFn: async () => {
      const d = await modelAdaptersApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!orgId && deployVersionId !== null,
    staleTime: 5 * 60_000,
  })

  const versions = versionsQuery.data ?? []
  const selected = useMemo(() => versions.find((v) => v.id === selectedId) ?? null, [versions, selectedId])
  const holdingDeployments = useMemo(() => (deploymentsQuery.data ?? []).filter((d) => holdsVersion(d.state)), [deploymentsQuery.data])
  const deploymentCount = selected ? holdingDeployments.filter((d) => d.modelVersionId === selected.id).length : 0

  const registerMutation = useMutation({
    mutationFn: (body: RegisterModelVersionBody) => modelVersionsApi.create(body),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['model-versions', orgId] })
      setRegisterOpen(false)
      notify.success('Version registered', created?.name ? `${created.name} is ready to deploy.` : undefined)
    },
    onError: (err) => notify.error('Could not register version', errorMessage(err, 'The server rejected the request.')),
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => modelVersionsApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['model-versions', orgId] })
      setSelectedId(null)
      notify.success('Version deleted', 'The weights stay in the registry.')
    },
    onError: (err) => notify.error('Could not delete version', errorMessage(err, 'The server rejected the request.')),
  })
  const deployMutation = useMutation({
    mutationFn: (body: CreateModelDeploymentBody) => modelDeploymentsApi.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['model-deployments', orgId] })
      setDeployVersionId(null)
      notify.success('Deployment queued', 'Track it on the Deployments tab.')
    },
    onError: (err) => notify.error('Could not create deployment', errorMessage(err, 'The server rejected the request.')),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Tracked artifacts</h2>
          <p className="text-sm text-muted-foreground">
            Optional. Most people never register anything here: naming the model on a deployment is enough. Register an artifact only when you want an immutable record of your own weights, pinned by etag or sha.
          </p>
        </div>
        <Button variant="outline" onClick={() => setRegisterOpen(true)} disabled={!orgId}>
          <Plus className="mr-2 h-4 w-4" />
          Register artifact
        </Button>
      </div>

      {versionsQuery.isError ? (
        <QueryError error={versionsQuery.error} onRetry={() => versionsQuery.refetch()} title="We couldn't load versions" />
      ) : (
        <VersionsList versions={versions} loading={versionsQuery.isLoading} onSelect={(v) => setSelectedId(v.id)} onRegister={() => setRegisterOpen(true)} />
      )}

      <RegisterVersionDialog open={registerOpen} onOpenChange={setRegisterOpen} onSubmit={(body) => registerMutation.mutate(body)} submitting={registerMutation.isPending} />

      <VersionDetailSheet
        version={selected}
        open={!!selected}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onDelete={(id) => deleteMutation.mutate(id)}
        onDeploy={(v) => {
          setSelectedId(null)
          setDeployVersionId(v.id)
        }}
        deploymentCount={deploymentCount}
        busy={deleteMutation.isPending}
      />

      <DeployDialog
        open={deployVersionId !== null}
        onOpenChange={(open) => !open && setDeployVersionId(null)}
        adapters={adaptersQuery.data ?? []}
        versions={versions}
        initialVersionId={deployVersionId ?? undefined}
        onSubmit={(body) => deployMutation.mutate(body)}
        submitting={deployMutation.isPending}
      />
    </div>
  )
}
