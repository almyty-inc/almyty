import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { FormPage } from '@/components/layout/form-page'
import { ProviderConnectionCreate } from '@/components/llm-providers/provider-connection-create'
import { safeReturnTo } from '@/lib/return-to'
import { providerPath } from '@/components/llm-providers/paths'

/**
 * Add a provider connection (under Credentials, /credentials/providers/new):
 * pick the provider, name the connection, paste its key, then untick any
 * model it should not offer. The picked tile lives in the URL
 * (?type=openai) so a link can open straight onto it.
 * Done goes back to the page that sent you (?returnTo=), else to the new
 * connection.
 */
export function ConnectProviderPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const returnTo = safeReturnTo(searchParams.get('returnTo'))

  useEffect(() => {
    document.title = 'Connect a provider | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const pick = (next: string | null) => {
    const params = new URLSearchParams(searchParams)
    if (next) params.set('type', next)
    else params.delete('type')
    setSearchParams(params)
  }

  return (
    <FormPage
      title="Connect a provider"
      description="Name the connection, paste its key and choose which of its models to offer. Several connections of one provider are fine."
      back={{ to: returnTo ?? '/credentials', label: returnTo ? 'Back' : 'Credentials' }}
      width="wide"
    >
      <ProviderConnectionCreate
        type={searchParams.get('type')}
        onTypeChange={pick}
        onDone={(provider) => navigate(returnTo ?? providerPath(provider.id))}
        idPrefix="connect"
      />
    </FormPage>
  )
}
