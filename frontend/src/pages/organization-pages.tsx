/* /organizations/new and /organizations/:id. The bodies live in
 * components/organizations/. */
import { useEffect } from 'react'

import { CreateOrganizationForm } from '@/components/organizations/create-organization-form'
import { OrganizationDetailPage as OrganizationDetail } from '@/components/organizations/organization-detail'

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [title])
}

export function OrganizationNewPage() {
  useTitle('Create organization')
  return <CreateOrganizationForm />
}

export function OrganizationDetailPage() {
  useTitle('Organization')
  return <OrganizationDetail />
}
