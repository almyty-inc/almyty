/* The Credentials pages that are not the list or the add page:
 *   /credentials/custom/new              add a custom service (admins)
 *   /credentials/policies/new            add a rule (admins)
 *   /credentials/policies/:policyId      edit one
 *   /credentials/:id                     one credential
 * and the redirects from where credentials used to live (Connections,
 * Settings > Connections). */
import { useEffect } from 'react'
import { Navigate, useLocation, useParams } from 'react-router-dom'

import { CredentialDetailPage } from '@/components/credentials/credential-detail'
import { CustomConnectorCreate } from '@/components/connections/custom-connector-form'
import { CREDENTIALS_PATH, addCredentialPath, credentialPath } from '@/components/credentials/paths'
import { ConnectionPolicyFormPage } from '@/components/connections-governance/policy-form'

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [title])
}

export function CredentialDetailRoutePage() {
  return <CredentialDetailPage />
}

export function CustomServiceNewPage() {
  useTitle('Add a custom service')
  return <CustomConnectorCreate />
}

export function CredentialPolicyPage() {
  const { policyId } = useParams<{ policyId?: string }>()
  useTitle(policyId ? 'Edit rule' : 'Add rule')
  return <ConnectionPolicyFormPage />
}

/**
 * Where an older address goes now: /connections/... and
 * /settings/connections/... keep their meaning under /credentials (the
 * list, Advanced, the add page opened on a service, one credential, the
 * custom service form and the rule pages), and a sign-in that comes back
 * to /connections?connection=<id> lands on that credential.
 */
export function credentialsTarget(pathname: string, search: string): string {
  const rest = pathname.replace(/^\/(settings\/)?connections\/?/, '')
  const params = new URLSearchParams(search)
  const [first, second] = rest.split('/').filter(Boolean)
  if (!first) {
    const returned = params.get('connection')
    return returned ? credentialPath(returned) : CREDENTIALS_PATH
  }
  if (first === 'advanced') return `${CREDENTIALS_PATH}/advanced`
  if (first === 'connect') return addCredentialPath(second ? decodeURIComponent(second) : params.get('service'), params.get('returnTo'))
  if (first === 'custom') return `${CREDENTIALS_PATH}/custom/new`
  if (first === 'policies') return `${CREDENTIALS_PATH}/policies/${second ?? 'new'}${params.get('kind') ? `?kind=${encodeURIComponent(params.get('kind')!)}` : ''}`
  return credentialPath(decodeURIComponent(first))
}

export function OldCredentialsAddressRedirect() {
  const { pathname, search } = useLocation()
  return <Navigate to={credentialsTarget(pathname, search)} replace />
}

/** Access keys live on the gateway or agent they unlock. */
export function AccessKeysRedirect() {
  return <Navigate to="/gateways" replace />
}
