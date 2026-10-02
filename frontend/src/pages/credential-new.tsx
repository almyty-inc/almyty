import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { FormPage } from '@/components/layout/form-page'
import { CredentialForm } from '@/components/credentials/credential-form'
import { CREDENTIALS_PATH, credentialPath } from '@/components/credentials/paths'
import { providerPath } from '@/components/llm-providers/paths'
import { safeReturnTo } from '@/lib/return-to'
import { useNotifications } from '@/store/app'

/**
 * Add credential (/credentials/new): one form. Name, the service it is
 * for, what that service needs, who can use it, Save. The picked service
 * lives in the URL (?service=mem0, ?service=model:openai) so a link can
 * open straight onto it. Saving goes back to the page that sent you
 * (?returnTo=), else to the new credential; a model provider's key, which
 * is saved as a provider connection, to that connection under Models.
 */
export function AddCredentialPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const notifications = useNotifications()
  const returnTo = safeReturnTo(searchParams.get('returnTo'))

  useEffect(() => {
    document.title = 'Add credential | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const pick = (next: string | null) => {
    const params = new URLSearchParams(searchParams)
    if (next) params.set('service', next)
    else params.delete('service')
    setSearchParams(params, { replace: true })
  }

  return (
    <FormPage title="Add credential" description="A key, a token or a sign-in at a service, saved once and used anywhere in almyty." back={{ to: returnTo ?? CREDENTIALS_PATH, label: returnTo ? 'Back' : 'Credentials' }} width="narrow">
      <CredentialForm
        service={searchParams.get('service')}
        onServiceChange={pick}
        onSaved={(saved) => {
          if (saved.provider) {
            notifications.success('Saved', `${saved.provider.name} is connected.`)
            navigate(returnTo ?? providerPath(saved.provider.id))
            return
          }
          notifications.success('Saved', `${saved.connection.name} is saved.`)
          navigate(returnTo ?? credentialPath(saved.connection.id))
        }}
      />
    </FormPage>
  )
}
