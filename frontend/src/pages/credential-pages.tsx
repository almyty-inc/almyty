/* The Credentials pages that are not the list or the add page:
 *   /credentials/custom/new              add a custom service (admins)
 *   /credentials/policies/new            add a rule (admins)
 *   /credentials/policies/:policyId      edit one
 *   /credentials/:id                     one credential */
import { useEffect } from 'react'
import { useParams } from 'react-router-dom'

import { CredentialDetailPage } from '@/components/credentials/credential-detail'
import { CustomConnectorCreate } from '@/components/connections/custom-connector-form'
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

