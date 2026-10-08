import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { FormPage } from '@/components/layout/form-page'
import { CredentialForm } from '@/components/credentials/credential-form'
import { modelServiceId, modelServiceType } from '@/components/credentials/services'
import { providerPath } from '@/components/llm-providers/paths'
import { safeReturnTo } from '@/lib/return-to'
import { useNotifications } from '@/store/app'
import { pluralized } from '@/lib/utils'

/**
 * Connect a provider (/models/providers/new): the add-credential form,
 * listing only model providers. Name the connection, pick the provider,
 * paste its key. The picked provider lives in the URL (?type=openai).
 * It starts and ends on Models: saving opens the new connection's page,
 * where its models are (all offered until some are unticked), or goes
 * back to the page that sent you (?returnTo=). The key is kept as a
 * credential too, and shows on Credentials as this connection's.
 */
export function ConnectProviderPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const notifications = useNotifications()
  const returnTo = safeReturnTo(searchParams.get('returnTo'))
  const type = searchParams.get('type')

  useEffect(() => {
    document.title = 'Connect a provider | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const pick = (next: string | null) => {
    const params = new URLSearchParams(searchParams)
    const nextType = modelServiceType(next)
    if (nextType) params.set('type', nextType)
    else params.delete('type')
    setSearchParams(params, { replace: true })
  }

  return (
    <FormPage
      title="Connect a provider"
      description="Its models show up in Models and in every model picker. Several connections of one provider are fine, each with its own key."
      back={{ to: returnTo ?? '/models', label: returnTo ? 'Back' : 'Models' }}
      width="narrow"
    >
      <CredentialForm
        modelsOnly
        idPrefix="connect"
        service={type ? modelServiceId(type) : null}
        onServiceChange={pick}
        onSaved={(saved) => {
          if (!saved.provider) return
          const count = saved.models.length
          notifications.success('Connected', count === 0 ? `${saved.provider.name} lists no models yet.` : `${saved.provider.name} offers ${pluralized(count, 'model', 'models')}.`)
          navigate(returnTo ?? providerPath(saved.provider.id))
        }}
      />
    </FormPage>
  )
}
