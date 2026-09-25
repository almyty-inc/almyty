/* The Connections pages that are not the list or the connect page:
 *   /connections/custom/new              add a custom service (admins)
 *   /connections/policies/new            add a rule (admins)
 *   /connections/policies/:policyId      edit one
 *   /connections/:id                     one connection
 * and the redirects from where connections and credentials used to live
 * (Settings > Connections, Credentials). */
import { useEffect } from 'react'
import { Navigate, useLocation, useParams } from 'react-router-dom'

import { ConnectionDetailPage } from '@/components/connections/connection-detail'
import { CustomConnectorCreate } from '@/components/connections/custom-connector-form'
import { OTHER_SERVICE_KEY } from '@/components/connections/connect-flow'
import { CONNECTIONS_PATH, connectServicePath, connectionPath } from '@/components/connections/paths'
import { ConnectionPolicyFormPage } from '@/components/connections-governance/policy-form'

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [title])
}

export function ConnectionDetailRoutePage() {
  return <ConnectionDetailPage />
}

export function CustomConnectorNewPage() {
  useTitle('Add a custom service')
  return <CustomConnectorCreate />
}

export function ConnectionPolicyPage() {
  const { policyId } = useParams<{ policyId?: string }>()
  useTitle(policyId ? 'Edit rule' : 'Add rule')
  return <ConnectionPolicyFormPage />
}

/**
 * Where a Settings > Connections address goes now. The sub-paths keep
 * their meaning: a connector's connect page, one connection, the custom
 * service form and the policy pages.
 */
export function settingsConnectionsTarget(pathname: string, search: string): string {
  const rest = pathname.replace(/^\/settings\/connections\/?/, '')
  const params = new URLSearchParams(search)
  const [first, second] = rest.split('/').filter(Boolean)
  if (!first) return `${CONNECTIONS_PATH}${search}`
  if (first === 'connect') return connectServicePath(second ? decodeURIComponent(second) : null, params.get('returnTo'))
  if (first === 'custom') return `${CONNECTIONS_PATH}/custom/new`
  if (first === 'policies') return `${CONNECTIONS_PATH}/policies/${second ?? 'new'}${search}`
  return connectionPath(decodeURIComponent(first))
}

export function SettingsConnectionsRedirect() {
  const { pathname, search } = useLocation()
  return <Navigate to={settingsConnectionsTarget(pathname, search)} replace />
}

/**
 * Credentials is Connections now: the list is the Connections page, "Add
 * credential" is "Other service", and access keys live on the gateway or
 * agent they unlock.
 */
export function credentialsTarget(pathname: string): string {
  if (pathname.startsWith('/credentials/access-keys')) return '/gateways'
  if (pathname.startsWith('/credentials/new')) return connectServicePath(OTHER_SERVICE_KEY)
  return CONNECTIONS_PATH
}

export function CredentialsRedirect() {
  const { pathname } = useLocation()
  return <Navigate to={credentialsTarget(pathname)} replace />
}
