import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { ApiForm } from '@/components/apis/api-form'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { apisApi } from '@/lib/api'
import type { Api } from '@/types'

/** `/apis/:id/edit` -- the API's name, address, authentication and visibility. */
export function ApiEditPage() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['api', id],
    queryFn: () => apisApi.getById(id!),
    enabled: !!id,
  })

  useEffect(() => {
    const name = (data as Api | undefined)?.name
    document.title = name ? `Edit ${name} | almyty` : 'Edit API | almyty'
    return () => { document.title = 'almyty' }
  }, [data])

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    )
  }
  if (isError || !data) {
    return <QueryError error={error} onRetry={() => refetch()} title="Couldn't load API" />
  }
  // Keyed so a different API re-seeds the form.
  return <ApiForm key={(data as Api).id} editingApi={data as Api} />
}
