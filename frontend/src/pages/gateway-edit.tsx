import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { FormPage } from '@/components/layout/form-page'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { GatewayEditForm } from '@/components/gateways/detail/gateway-edit-form'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

/**
 * Edit a gateway's settings and who can see it: a page of its own
 * (/gateways/:id/edit), not a modal. Saving returns to the detail page.
 */
export function GatewayEditPage() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  // Unsaved edits ask before a navigation throws them away; a save that
  // lands leaves for the detail page without asking.
  const [dirty, setDirty] = useState(false)
  const guard = useLeaveGuard(dirty)

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
      guard.leave(`/gateways/${id}`)
    },
    onError: (err: any) => {
      errorNotif('Failed to update gateway', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  return (
    <FormPage
      title="Edit gateway"
      description="The protocol cannot be changed after creation."
      back={{ to: `/gateways/${id}`, label: gateway?.name ?? 'Gateway' }}
      guard={guard}
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner />
        </div>
      ) : isError ? (
        <QueryError error={error} onRetry={() => refetch()} title="Couldn't load this gateway" />
      ) : (
        <GatewayEditForm
          gateway={gateway}
          isSaving={editGatewayMutation.isPending}
          onSubmit={(data) => editGatewayMutation.mutate(data)}
          onCancel={() => guard.navigate(`/gateways/${id}`)}
          onDirtyChange={setDirty}
          isSystem={gateway?.isSystem}
        />
      )}
    </FormPage>
  )
}
