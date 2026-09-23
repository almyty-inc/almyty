import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { GatewayEditForm } from '@/components/gateways/detail/gateway-edit-form'

/**
 * Edit a gateway's settings and who can see it: a page of its own
 * (/gateways/:id/edit), not a modal. Saving returns to the detail page.
 */
export function GatewayEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const { data: gateway, isLoading, isError, error, refetch } = useQuery<any>({
    queryKey: ['gateway', id],
    queryFn: () => gatewaysApi.getById(id!),
    enabled: !!id,
  })

  useEffect(() => {
    document.title = `Edit ${gateway?.name ?? 'gateway'} | almyty`
    return () => { document.title = 'almyty' }
  }, [gateway?.name])

  const editGatewayMutation = useMutation({
    mutationFn: (data: Record<string, any>) => gatewaysApi.update(id!, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Gateway updated', 'Gateway has been updated successfully.')
      navigate(`/gateways/${id}`)
    },
    onError: (err: any) => {
      errorNotif('Failed to update gateway', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/gateways/${id}`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" />
          {gateway?.name ?? 'Gateway'}
        </Link>
      </div>

      <div>
        <h1 className={DETAIL_TITLE_CLASSES}>Edit gateway</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The gateway type cannot be changed after creation.
        </p>
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <QueryError error={error} onRetry={() => refetch()} title="Couldn't load this gateway" />
      ) : (
        <Card className="max-w-3xl">
          <CardContent className="pt-6">
            <GatewayEditForm
              gateway={gateway}
              isSaving={editGatewayMutation.isPending}
              onSubmit={(data) => editGatewayMutation.mutate(data)}
              onCancel={() => navigate(`/gateways/${id}`)}
              isSystem={gateway?.isSystem}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
