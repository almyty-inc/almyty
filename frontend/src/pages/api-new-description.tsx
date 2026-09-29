import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Checkbox } from '@/components/ui/checkbox'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { VisibilityValue } from '@/components/ui/visibility-field'
import { WhoCanUse } from '@/components/connect/who-can-use'
import { ApiSourceField, sourceError, sourceOf, type ApiSourceValue } from '@/components/apis/api-source-field'
import { DESCRIPTION_KINDS, isDescriptionApiType } from '@/components/apis/api-types'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { apisApi, organizationsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useOrganizationStore } from '@/store/organization'
import type { ApiKeyType, DescriptionApiType } from '@/types/api-connect'
import { setupPath } from './api-new'

const SIGN_IN_OPTIONS: Array<{ value: ApiKeyType | 'detect'; label: string }> = [
  { value: 'detect', label: 'From the description' },
  { value: 'none', label: 'No key' },
  { value: 'api_key', label: 'Key in a header' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Username and password' },
  { value: 'oauth2', label: 'OAuth 2.0' },
]

/** `/apis/new/:type`: an OpenAPI, GraphQL, SOAP or gRPC API, from its description. */
export function ApiNewDescriptionPage() {
  const { type } = useParams<{ type: string }>()
  if (!isDescriptionApiType(type)) return <Navigate to="/apis/new" replace />
  return <DescriptionForm key={type} type={type} />
}

function DescriptionForm({ type }: { type: DescriptionApiType }) {
  const kind = DESCRIPTION_KINDS[type]
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id ?? ''

  const [source, setSource] = useState<ApiSourceValue>({ mode: kind.modes[0], link: '', file: null, text: '' })
  const [sourceProblem, setSourceProblem] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [baseUrlError, setBaseUrlError] = useState<string | undefined>()
  const [signIn, setSignIn] = useState<ApiKeyType | 'detect'>('detect')
  const [makeTools, setMakeTools] = useState(true)
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })

  useEffect(() => {
    document.title = `Connect an API: ${kind.label} | almyty`
    return () => {
      document.title = 'almyty'
    }
  }, [kind.label])

  // Who can use it is only a question when there is more than one answer
  // worth giving: an organization without teams keeps its APIs org-wide.
  const teamsQuery = useQuery({
    queryKey: ['organization-teams', orgId],
    queryFn: () => organizationsApi.getTeams(orgId),
    enabled: !!orgId,
  })
  const hasTeams = Array.isArray(teamsQuery.data) && teamsQuery.data.length > 0

  const dirty = !!source.file || source.link.trim() !== '' || source.text.trim() !== '' || name !== '' || baseUrl !== ''
  const importing = useMutation({
    mutationFn: () => {
      const given = sourceOf(source)!
      return apisApi.connect(
        {
          type,
          ...(given.url ? { url: given.url } : {}),
          ...(given.content ? { content: given.content } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(signIn !== 'detect' ? { authType: signIn } : {}),
          ...(makeTools ? {} : { generateTools: false }),
          ...(hasTeams ? { visibility: visibility.visibility, teamId: visibility.teamId } : {}),
        },
        given.file,
      )
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      guard.leave(setupPath(result))
    },
    onError: (err) => setSourceProblem(getApiErrorMessage(err, 'The import did not start. Please try again.')),
  })
  const guard = useLeaveGuard(dirty && !importing.isPending && !importing.isSuccess)

  const submit = () => {
    const problem = sourceError(source)
    setSourceProblem(problem)
    const addressProblem = baseUrl.trim() && !/^https?:\/\/.+/i.test(baseUrl.trim()) ? 'The address must start with http:// or https://.' : undefined
    setBaseUrlError(addressProblem)
    if (problem || addressProblem) return
    importing.mutate()
  }

  return (
    <FormPage
      title="Connect an API"
      description={`${kind.label}: every operation in its description becomes a tool.`}
      back={{ to: '/apis/new', label: 'Connect an API' }}
      guard={guard}
      onSubmit={submit}
      submitLabel={importing.isPending ? 'Reading it...' : 'Connect API'}
      submitting={importing.isPending}
    >
      <FormSection title="Description">
        <ApiSourceField
          id="api-source"
          kind={kind}
          value={source}
          onChange={(next) => {
            setSource(next)
            setSourceProblem(null)
          }}
          error={sourceProblem}
          disabled={importing.isPending}
        />
      </FormSection>

      <Disclosure title="Advanced">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="api-name" label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="From the description" maxLength={100} />
          </Field>
          <Field id="api-address" label="Address" error={baseUrlError}>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="From the description" />
          </Field>
          <div className="space-y-1.5">
            <Label htmlFor="api-sign-in">Sign-in</Label>
            <Select value={signIn} onValueChange={(v) => setSignIn(v as ApiKeyType | 'detect')}>
              <SelectTrigger id="api-sign-in">
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
          </div>
        </div>
        {hasTeams && <WhoCanUse value={visibility} onChange={setVisibility} noun="this API and its tools" />}
        <div className="flex items-center gap-2">
          <Checkbox id="api-make-tools" checked={makeTools} onCheckedChange={(v) => setMakeTools(v === true)} />
          <Label htmlFor="api-make-tools" className="cursor-pointer font-normal">
            Make a tool for every operation
          </Label>
        </div>
      </Disclosure>
    </FormPage>
  )
}
