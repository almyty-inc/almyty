/* Pages under Settings > Connections that used to be sheets and dialogs:
 *   /settings/connections/connect                 pick a connector, then connect
 *   /settings/connections/connect/:connectorKey   connect that connector
 *   /settings/connections/custom/new              add a custom connector
 *   /settings/connections/policies/new            add a governance policy
 *   /settings/connections/policies/:policyId      edit one
 *   /settings/connections/:id                     one connection
 * The bodies live in components/connections/ and
 * components/connections-governance/. */
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { FormPage } from '@/components/layout/form-page'
import { ConnectFlow, CONNECTORS_QUERY_KEY, connectTitle } from '@/components/connections/connect-sheet'
import { CONNECTIONS_PATH, CONNECTIONS_QUERY_KEY, ConnectionDetailPage as ConnectionDetailBody } from '@/components/connections/connection-detail'
import { CustomConnectorCreate } from '@/components/connections/custom-connector-form'
import { ConnectionPolicyFormPage } from '@/components/connections-governance/policy-form'
import { connectorsApi } from '@/lib/connections-api'
import { useNotifications } from '@/store/app'

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [title])
}

/**
 * `?returnTo=` sends the user back where they started (a consumer page
 * that linked here). Only a same-origin path is honoured.
 */
export function safeReturnTo(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
  return raw
}

export function ConnectionConnectPage() {
  const { connectorKey } = useParams<{ connectorKey?: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const returnTo = safeReturnTo(searchParams.get('returnTo'))

  const connectorsQuery = useQuery({
    queryKey: CONNECTORS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectorsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
  const connector = connectorKey ? (connectorsQuery.data ?? []).find((c) => c.key === connectorKey) ?? null : null
  const title = connectTitle(connector)
  useTitle(title)

  const back = connectorKey
    ? { to: `${CONNECTIONS_PATH}/connect${searchParams.toString() ? `?${searchParams}` : ''}`, label: 'All connectors' }
    : { to: returnTo ?? CONNECTIONS_PATH, label: returnTo ? 'Back' : 'Connections' }

  return (
    <FormPage
      title={title}
      description={
        connector
          ? connector.description || `Connect ${connector.displayName} once and reuse it wherever almyty needs it.`
          : 'Pick what to connect. Secrets are encrypted at rest and never shown again.'
      }
      back={back}
      width="narrow"
    >
      <ConnectFlow
        key={connectorKey ?? 'pick'}
        connectorKey={connectorKey}
        onPick={(c) => navigate(`${CONNECTIONS_PATH}/connect/${encodeURIComponent(c.key)}${searchParams.toString() ? `?${searchParams}` : ''}`)}
        onCancel={() => navigate(returnTo ?? CONNECTIONS_PATH)}
        onConnected={(connection) => {
          queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
          notifications.success('Connected', `${connection.name} is ${connection.health?.status === 'valid' ? 'valid and ' : ''}ready to use.`)
          navigate(returnTo ?? `${CONNECTIONS_PATH}/${connection.id}`)
        }}
      />
    </FormPage>
  )
}

export function ConnectionDetailRoutePage() {
  useTitle('Connection')
  return <ConnectionDetailBody />
}

export function CustomConnectorNewPage() {
  useTitle('Add custom connector')
  return <CustomConnectorCreate />
}

export function ConnectionPolicyPage() {
  const { policyId } = useParams<{ policyId?: string }>()
  useTitle(policyId ? 'Edit policy' : 'Add policy')
  return <ConnectionPolicyFormPage />
}
