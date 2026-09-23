import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { SchemaImportForm } from '@/components/apis/schema-import-form'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { apisApi } from '@/lib/api'
import type { Api } from '@/types'

/**
 * `/apis/:id/import` -- import a schema into an API. Step 2 of connecting
 * one (`?created=1`), and where "Import schema" on the API's page leads.
 */
export function ApiImportPage() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['api', id],
    queryFn: () => apisApi.getById(id!),
    enabled: !!id,
  })

  useEffect(() => {
    const name = (data as Api | undefined)?.name
    document.title = name ? `Import schema: ${name} | almyty` : 'Import schema | almyty'
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
  return <SchemaImportForm api={data as Api} />
}
