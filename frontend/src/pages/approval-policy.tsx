/* /settings/approvals/policies/new and /settings/approvals/policies/:policyId
 * -- the approval policy form. It lives in
 * components/settings/approval-policy-form.tsx. */
import { useEffect } from 'react'
import { useParams } from 'react-router-dom'

import { ApprovalPolicyFormPage } from '@/components/settings/approval-policy-form'

export function ApprovalPolicyPage() {
  const { policyId } = useParams<{ policyId?: string }>()
  useEffect(() => {
    document.title = `${policyId ? 'Edit approval policy' : 'New approval policy'} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [policyId])
  return <ApprovalPolicyFormPage />
}
