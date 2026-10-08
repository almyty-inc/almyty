import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { EnvironmentForm } from '@/components/runners/environment-form'
import { HostedUnavailable, environmentPath, useEnvironments } from '@/components/runners/hosted-environments-tab'
import { environmentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'

export const HOSTED_TAB_PATH = '/runners?tab=hosted'

/** Describe a hosted environment once, on a page. Nothing starts until an agent or tool uses it. */
export function EnvironmentNewPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: notifyError } = useNotifications()
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const list = useEnvironments()

  useEffect(() => {
    document.title = 'New environment | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => environmentsApi.create(body),
    onSuccess: (env: any) => {
      success('Environment created')
      queryClient.invalidateQueries({ queryKey: ['environments'] })
      navigate(env?.id ? environmentPath(env.id) : HOSTED_TAB_PATH)
    },
    onError: (err) => notifyError('Could not create the environment', getApiErrorMessage(err)),
  })

  return (
    <div className="space-y-6">
      <Link to={HOSTED_TAB_PATH} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" />Runners
      </Link>
      <div>
        <h1 className={DETAIL_TITLE_CLASSES}>New environment</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A machine almyty runs for you. It starts when an agent needs it and parks itself when nobody uses it; its files stay.
        </p>
      </div>
      {list.isLoading ? (
        <div className="py-12 flex justify-center"><LoadingSpinner size="lg" /></div>
      ) : list.isError ? (
        <QueryError error={list.error as Error} onRetry={() => list.refetch()} title="Couldn't load hosted environments" />
      ) : list.enabled === false ? (
        <HostedUnavailable />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <EnvironmentForm
              organizationId={orgId ?? ''}
              settings={list.settings}
              submitLabel="Create environment"
              submitting={create.isPending}
              onSubmit={(body) => create.mutate(body)}
              onCancel={() => navigate(HOSTED_TAB_PATH)}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
