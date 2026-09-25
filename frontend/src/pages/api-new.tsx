import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { VisibilityValue } from '@/components/ui/visibility-field'
import { PageHeader } from '@/components/layout/page-header'
import { WhoCanUse } from '@/components/connect/who-can-use'
import { SourceBox, readSource } from '@/components/apis/source-box'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { apisApi, organizationsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useOrganizationStore } from '@/store/organization'
import type { ApiKeyType, ConnectApiResult } from '@/types/api-connect'

const SIGN_IN_OPTIONS: Array<{ value: ApiKeyType | 'detect'; label: string }> = [
  { value: 'detect', label: 'From the description' },
  { value: 'none', label: 'No key' },
  { value: 'api_key', label: 'Key in a header' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Username and password' },
  { value: 'oauth2', label: 'OAuth 2.0' },
]

/** Where "Finish connecting" picks up: the import job, and what is still needed. */
export function setupPath(result: ConnectApiResult): string {
  const params = new URLSearchParams({ job: String(result.jobId) })
  if (result.needs.key) params.set('key', '1')
  if (result.needs.address) params.set('address', '1')
  return `/apis/${result.api.id}/setup?${params.toString()}`
}

/**
 * `/apis/new`: connect an API from its description. One box (a link, a
 * file, or the text itself) and one button. The server works out what it
 * is and fills in the rest; "Advanced" holds the few things it cannot
 * know. The next page asks for a key only when the API needs one.
 */
export function ApiNewPage() {
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id ?? ''

  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [signIn, setSignIn] = useState<ApiKeyType | 'detect'>('detect')
  const [makeTools, setMakeTools] = useState(true)
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Connect an API | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  // Who can use it is only a question when there is more than one answer
  // worth giving: an organization without teams keeps its APIs org-wide.
  const teamsQuery = useQuery({
    queryKey: ['organization-teams', orgId],
    queryFn: () => organizationsApi.getTeams(orgId),
    enabled: !!orgId,
  })
  const hasTeams = Array.isArray(teamsQuery.data) && teamsQuery.data.length > 0

  const dirty = !!file || text.trim() !== '' || name !== '' || baseUrl !== ''
  const importing = useMutation({
    mutationFn: () => {
      const source = readSource(text, file)!
      return apisApi.connect(
        {
          ...(source.url ? { url: source.url } : {}),
          ...(source.content ? { content: source.content } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(signIn !== 'detect' ? { authType: signIn } : {}),
          ...(makeTools ? {} : { generateTools: false }),
          ...(hasTeams ? { visibility: visibility.visibility, teamId: visibility.teamId } : {}),
        },
        source.file,
      )
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      guard.leave(setupPath(result))
    },
    onError: (err) => setError(getApiErrorMessage(err, 'The import did not start. Please try again.')),
  })
  const guard = useLeaveGuard(dirty && !importing.isPending && !importing.isSuccess)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!readSource(text, file)) {
      setError('Paste a link, drop a file, or paste the description first.')
      document.getElementById('api-source')?.focus()
      return
    }
    if (baseUrl.trim() && !/^https?:\/\/.+/i.test(baseUrl.trim())) {
      setError('The address must start with http:// or https://.')
      return
    }
    importing.mutate()
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to="/apis" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        APIs
      </Link>
      <PageHeader title="Connect an API" description="Give almyty the API's description. It reads the rest and makes a tool for every operation." />

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={submit} className="space-y-5" noValidate aria-label="Connect an API">
            <SourceBox
              id="api-source"
              text={text}
              file={file}
              onTextChange={(next) => {
                setText(next)
                setError(null)
              }}
              onFileChange={(next) => {
                setFile(next)
                setError(null)
              }}
              error={error}
              disabled={importing.isPending}
            />

            <Disclosure title="Advanced">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="api-name">Name</Label>
                  <Input id="api-name" className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="From the description" maxLength={100} />
                </div>
                <div>
                  <Label htmlFor="api-address">Address</Label>
                  <Input id="api-address" className="mt-1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="From the description" />
                </div>
                <div>
                  <Label htmlFor="api-sign-in">Sign-in</Label>
                  <Select value={signIn} onValueChange={(v) => setSignIn(v as ApiKeyType | 'detect')}>
                    <SelectTrigger id="api-sign-in" className="mt-1">
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

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={importing.isPending}>
                {importing.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                {importing.isPending ? 'Reading it...' : 'Import'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground" data-testid="other-ways">
        Other ways:{' '}
        <Link to="/apis/new/sdk" className="text-primary hover:underline">
          import an npm package
        </Link>
        {' · '}
        Want a single call instead?{' '}
        <Link to="/tools/new" className="text-primary hover:underline">
          Create a tool
        </Link>
      </p>
      {guard.element}
    </div>
  )
}
