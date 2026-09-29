import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { VisibilityValue } from '@/components/ui/visibility-field'
import { WhoCanUse } from '@/components/connect/who-can-use'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { apisApi, organizationsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { ApiKeyType } from '@/types/api-connect'

type SignIn = Exclude<ApiKeyType, 'oauth2'>

const SIGN_IN_OPTIONS: Array<{ value: SignIn; label: string }> = [
  { value: 'none', label: 'No key' },
  { value: 'api_key', label: 'Key in a header' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Username and password' },
]

/** How the key is sent, in the shape the API's authentication takes. */
export function httpAuthentication(signIn: SignIn, headerName: string): { type: SignIn; config: Record<string, string> } {
  if (signIn === 'api_key') return { type: 'api_key', config: { headerName: headerName.trim() || 'X-API-Key', location: 'header' } }
  return { type: signIn, config: {} }
}

/**
 * `/apis/new/http`: an API with no description to read, just its address.
 * Its tools are added by hand on the Tools page, calling paths under the
 * address. When it takes a key, "Finish connecting" asks for it next, with
 * the same pick-or-create credential control as every other API.
 */
export function ApiNewHttpPage() {
  const queryClient = useQueryClient()
  const { error: notifyError } = useNotifications()
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id ?? ''

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [description, setDescription] = useState('')
  const [signIn, setSignIn] = useState<SignIn>('none')
  const [headerName, setHeaderName] = useState('X-API-Key')
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [errors, setErrors] = useState<{ name?: string; baseUrl?: string }>({})

  useEffect(() => {
    document.title = 'Connect an API: Manual HTTP | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const teamsQuery = useQuery({
    queryKey: ['organization-teams', orgId],
    queryFn: () => organizationsApi.getTeams(orgId),
    enabled: !!orgId,
  })
  const hasTeams = Array.isArray(teamsQuery.data) && teamsQuery.data.length > 0

  const create = useMutation({
    mutationFn: () =>
      apisApi.createHttpApi({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        authentication: httpAuthentication(signIn, headerName),
        ...(hasTeams ? { visibility: visibility.visibility, teamId: visibility.teamId } : {}),
      }),
    onSuccess: (api: any) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      const id = api?.id
      guard.leave(!id ? '/apis' : signIn === 'none' ? `/apis/${id}` : `/apis/${id}/setup?key=1`)
    },
    onError: (err) => notifyError('Could not connect the API', getApiErrorMessage(err, 'Please try again.')),
  })
  const guard = useLeaveGuard(!create.isSuccess && (name !== '' || baseUrl !== '' || description !== ''))

  const submit = () => {
    const next: typeof errors = {}
    if (!name.trim()) next.name = 'Give it a name.'
    if (!/^https?:\/\/\S+$/i.test(baseUrl.trim())) next.baseUrl = 'Enter the address, starting with http:// or https://.'
    setErrors(next)
    if (next.name || next.baseUrl) return
    create.mutate()
  }

  return (
    <FormPage
      title="Connect an API"
      description="Manual HTTP: an address to call. You add its tools by hand, each calling a path under it."
      back={{ to: '/apis/new', label: 'Connect an API' }}
      guard={guard}
      onSubmit={submit}
      submitLabel="Connect API"
      submitting={create.isPending}
    >
      <FormSection title="API">
        <Field id="http-api-name" label="Name" error={errors.name} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme orders" maxLength={100} />
        </Field>
        <Field id="http-api-address" label="Address" hint="Tools call paths under it, such as /orders." error={errors.baseUrl} required>
          <Input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
        </Field>
        <Field id="http-api-description" label="Description">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this API is for" />
        </Field>
      </FormSection>

      <FormSection title="Sign-in" description="The key itself is picked or added on the next page.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="http-api-sign-in" label="How it signs in">
            <Select value={signIn} onValueChange={(v) => setSignIn(v as SignIn)}>
              <SelectTrigger id="http-api-sign-in">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIGN_IN_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {signIn === 'api_key' && (
            <Field id="http-api-header" label="Header">
              <Input value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
            </Field>
          )}
        </div>
      </FormSection>

      {hasTeams && (
        <FormSection title="Who can use it">
          <WhoCanUse value={visibility} onChange={setVisibility} noun="this API and its tools" />
        </FormSection>
      )}
    </FormPage>
  )
}
