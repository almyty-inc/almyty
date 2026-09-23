/* Create pages for the Credentials area: a vault secret and an access key.
 * The forms live in components/credentials/. */
import { useEffect } from 'react'

import { CreateCredentialForm } from '@/components/credentials/create-credential-form'
import { GenerateAccessKeyForm } from '@/components/credentials/generate-access-key-form'

function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [title])
}

export function CredentialNewPage() {
  useTitle('Add credential')
  return <CreateCredentialForm />
}

export function AccessKeyNewPage() {
  useTitle('Generate access key')
  return <GenerateAccessKeyForm />
}
