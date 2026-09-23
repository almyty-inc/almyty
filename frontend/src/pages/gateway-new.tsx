import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeft } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { captureEvent } from '@/lib/analytics'
import { useNotifications } from '@/store/app'
import { GatewayCreateForm } from '@/components/gateways/gateway-create-form'
import { createGatewaySchema, type CreateGatewayForm } from '@/components/gateways/schema'

/** Default configuration per gateway type, as the create flow has always sent it. */
function defaultConfiguration(type: string): Record<string, any> {
  switch (type) {
    case 'mcp': return { transport: 'http' }
    case 'a2a': return { agentCapabilities: {} }
    case 'acp': return { agentCapabilities: {} }
    case 'utcp': return { protocol: 'http' }
    case 'skills': return { format: 'skill-md' }
    default: return {}
  }
}

/**
 * Create a gateway: a page of its own (/gateways/new), not a modal. On
 * success it lands on the new gateway's detail page.
 */
export function GatewayNewPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  useEffect(() => {
    document.title = 'New gateway | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const createForm = useForm<CreateGatewayForm>({
    resolver: zodResolver(createGatewaySchema),
    defaultValues: { name: '', type: '', endpoint: '', description: '' },
  })

  const createGatewayMutation = useMutation({
    mutationFn: (payload: Record<string, any>) => gatewaysApi.create(payload),
    onSuccess: async (result: any) => {
      captureEvent('gateway_deployed')
      success('Gateway created', result?.message || 'It is now serving on its protocol endpoint.')
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      const created = result?.data ?? result
      navigate(created?.id ? `/gateways/${created.id}` : '/gateways')
    },
    onError: (err: unknown) => {
      errorNotif('Error', getApiErrorMessage(err, 'Failed to create gateway'))
    },
  })

  const handleCreateGateway = (data: CreateGatewayForm & { kind?: string; agentId?: string }) => {
    const endpoint = data.endpoint.startsWith('/') ? data.endpoint : '/' + data.endpoint
    const payload: Record<string, any> = {
      ...data,
      endpoint,
      configuration: defaultConfiguration(data.type),
    }
    if (data.kind) payload.kind = data.kind
    if (data.agentId) payload.agentId = data.agentId
    createGatewayMutation.mutate(payload)
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/gateways" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Gateways
        </Link>
      </div>

      <div>
        <h1 className={DETAIL_TITLE_CLASSES}>New gateway</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Expose your tools or an agent over a protocol: MCP, UTCP, Agent Skills, A2A, OpenAI Chat, or a chat channel.
        </p>
      </div>

      <Card className="max-w-3xl">
        <CardContent className="pt-6">
          <GatewayCreateForm
            createForm={createForm}
            onSubmit={handleCreateGateway}
            createGatewayMutation={createGatewayMutation}
            onCancel={() => navigate('/gateways')}
          />
        </CardContent>
      </Card>
    </div>
  )
}
