import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { useConnectionOptions } from '@/components/connections/connection-select'
import { providerApi, type ProviderApi } from '@/components/apis/provider-apis'
import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import type { Connection } from '@/types/connections'
import { setupPath } from './api-new'

/** The first credential kept for this provider, in the order its services are preferred. */
export function providerCredential(credentials: Connection[], provider: ProviderApi): Connection | null {
  for (const key of provider.connectorKeys) {
    const found = credentials.find((c) => c.connectorKey === key && c.health?.status !== 'failed')
    if (found) return found
  }
  return null
}

/** `/apis/new/provider/:key`: a model provider's own API, called with its key. */
export function ApiNewProviderPage() {
  const { key } = useParams<{ key: string }>()
  const provider = providerApi(key)
  if (!provider) return <Navigate to="/apis/new" replace />
  return <ProviderApiForm key={provider.key} provider={provider} />
}

function ProviderApiForm({ provider }: { provider: ProviderApi }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const options = useConnectionOptions({})
  const [credentialId, setCredentialId] = useState('')
  const [picked, setPicked] = useState(false)
  const [credentialError, setCredentialError] = useState<string | undefined>()
  const [name, setName] = useState(provider.apiName)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    document.title = `Connect an API: ${provider.label} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [provider.label])

  // The provider's key the organization already keeps, until someone picks another.
  const kept = providerCredential(options.all, provider)
  const value = picked ? credentialId : credentialId || kept?.id || ''

  const importing = useMutation({
    mutationFn: async () => {
      const result = await apisApi.connect({ type: 'openapi', url: provider.specUrl, name: name.trim() || provider.apiName })
      // The API exists now; if the key does not stick, "Finish connecting" asks for it.
      const keySaved = await apisApi.setKey(result.api.id, { type: 'bearer', connectionId: value }).then(() => true, () => false)
      return { ...result, needs: { ...result.needs, key: !keySaved } }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      navigate(setupPath(result))
    },
    onError: (err) => setProblem(getApiErrorMessage(err, 'The import did not start. Please try again.')),
  })

  const submit = () => {
    setProblem(null)
    if (!value) {
      setCredentialError(`Pick your ${provider.label} key, or create one here.`)
      return
    }
    importing.mutate()
  }

  return (
    <FormPage
      title={`Connect ${provider.label}`}
      description={`Every operation in ${provider.label}'s published API description becomes a tool, called with your ${provider.label} key.`}
      back={{ to: '/apis/new', label: 'Connect an API' }}
      onSubmit={submit}
      submitLabel={importing.isPending ? 'Reading it...' : 'Connect API'}
      submitting={importing.isPending}
    >
      <FormSection title="Key">
        <CredentialPicker
          id="provider-api-credential"
          label={`${provider.label} key`}
          value={value}
          connectorKey={provider.connectorKeys[0]}
          required
          error={credentialError}
          disabled={importing.isPending}
          hint={kept && value === kept.id ? `The ${provider.label} key your organization already keeps.` : 'Saved in Credentials, so models and tools can use it too.'}
          onChange={(credential) => {
            setPicked(true)
            setCredentialId(credential?.id ?? '')
            setCredentialError(undefined)
          }}
        />
        {problem && (
          <p role="alert" className="text-sm text-destructive" data-testid="provider-api-error">
            {problem}
          </p>
        )}
      </FormSection>

      <Disclosure title="Advanced">
        <Field id="provider-api-name" label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} disabled={importing.isPending} />
        </Field>
        <p className="mt-3 text-xs text-muted-foreground">
          Read from{' '}
          <a href={provider.specUrl} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">
            {provider.specUrl}
          </a>
        </p>
      </Disclosure>
    </FormPage>
  )
}
