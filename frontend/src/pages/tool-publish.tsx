import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { PublishToolForm, isPublishable, type PublishableTool } from '@/components/tools/publish-tool-form'
import { FormPage } from '@/components/layout/form-page'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'

/** `/tools/:id/publish` -- publish a tool as a template in the org's tool hub. */
export function ToolPublishPage() {
  const { id } = useParams<{ id: string }>()
  const { currentOrganization } = useOrganizationStore()
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tool', id],
    queryFn: () => toolsApi.getById(id!, currentOrganization!.id),
    enabled: !!id && !!currentOrganization,
  })
  const tool = data as PublishableTool | undefined

  useEffect(() => {
    document.title = tool?.name ? `Publish ${tool.name} | almyty` : 'Publish tool | almyty'
    return () => { document.title = 'almyty' }
  }, [tool?.name])

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    )
  }
  if (isError || !tool) {
    return <QueryError error={error} onRetry={() => refetch()} title="Couldn't load tool" />
  }
  if (!isPublishable(tool)) {
    // Nothing else round-trips: installing a template rebuilds a tool from
    // its HTTP config alone.
    return (
      <FormPage title="Publish to Tool Hub" back={{ to: `/tools/${tool.id}`, label: tool.name }} width="narrow">
        <p className="text-sm text-muted-foreground">
          Only HTTP tools can be published as templates.{' '}
          <Link to={`/tools/${tool.id}`} className="underline">Back to {tool.name}</Link>
        </p>
      </FormPage>
    )
  }
  return <PublishToolForm key={tool.id} tool={tool} />
}
