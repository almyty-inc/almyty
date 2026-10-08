/* The credential pages that are not the list or the add page:
 *   /credentials/:id                         one credential
 *   /settings/credential-rules/new           add a credential rule (admins)
 *   /settings/credential-rules/:policyId     edit one */
import { useEffect } from 'react'
import { useParams } from 'react-router-dom'

import { CredentialDetailPage } from '@/components/credentials/credential-detail'
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

export function CredentialPolicyPage() {
  const { policyId } = useParams<{ policyId?: string }>()
  useTitle(policyId ? 'Edit rule' : 'Add rule')
  return <ConnectionPolicyFormPage />
}
