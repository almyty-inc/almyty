import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { PageHeader } from '@/components/layout/page-header'
import { ApiKeyForm } from '@/components/apis/api-key-form'
import { apiKeyQueryKey } from '@/components/apis/detail/key-card'
import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import type { Api } from '@/types'

type ImportState = { status: 'running' } | { status: 'done'; operations: number; tools: number } | { status: 'failed'; error: string }

function countsOf(result: any): { operations: number; tools: number } {
  const r = result?.result ?? result
  return {
    operations: r?.operations?.length ?? r?.operationCount ?? 0,
    tools: r?.tools?.length ?? r?.toolCount ?? 0,
  }
}

/**
 * `/apis/:id/setup`: "Finish connecting". The import runs in the
 * background while this page asks for the one or two things the
 * description could not say: the key (`?key=1`) and, for a description
 * without an address (`?address=1`, every .proto), the address calls go to.
 * With nothing to ask it goes straight on to the API once the import is
 * done. The job id rides in the URL, so a refresh or an OAuth sign-in
 * that comes back here picks it up again.
 */
export function ApiSetupPage() {
  const { id = '' } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const job = searchParams.get('job')
  const askKey = searchParams.get('key') === '1'
  const askAddress = searchParams.get('address') === '1'

  const apiQuery = useQuery({ queryKey: ['api', id], queryFn: () => apisApi.getById(id), enabled: !!id })
  const keyQuery = useQuery({ queryKey: apiKeyQueryKey(id), queryFn: () => apisApi.getKey(id), enabled: !!id && askKey })
  const api = apiQuery.data as Api | undefined

  const [importState, setImportState] = useState<ImportState>(job ? { status: 'running' } : { status: 'done', operations: 0, tools: 0 })
  const polled = useRef<string | null>(null)
  useEffect(() => {
    if (!job || polled.current === job) return
    polled.current = job
    apisApi
      .pollImportStatus(id, job)
      .then((result) => {
        setImportState({ status: 'done', ...countsOf(result) })
        queryClient.invalidateQueries({ queryKey: ['api', id] })
        queryClient.invalidateQueries({ queryKey: ['api-schemas', id] })
        queryClient.invalidateQueries({ queryKey: ['api-operations', id] })
        queryClient.invalidateQueries({ queryKey: ['apis'] })
        queryClient.invalidateQueries({ queryKey: ['tools'] })
      })
      .catch((err) => setImportState({ status: 'failed', error: getApiErrorMessage(err, 'The import failed.') }))
  }, [id, job, queryClient])

  const [address, setAddress] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)
  const saveAddress = useMutation({
    mutationFn: () => apisApi.update(id, { baseUrl: address.trim() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api', id] }),
    onError: (err) => setAddressError(getApiErrorMessage(err, 'The address was not saved.')),
  })

  const keyDone = !askKey || !!keyQuery.data?.source
  const addressDone = !askAddress || !!api?.baseUrl
  const importDone = importState.status === 'done'
  const everythingDone = keyDone && addressDone && importDone

  useEffect(() => {
    document.title = api?.name ? `Finish connecting ${api.name} | almyty` : 'Finish connecting | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [api?.name])

  // Nothing to ask: on to the API as soon as its import is in.
  useEffect(() => {
    if (!askKey && !askAddress && importDone) navigate(`/apis/${id}`, { replace: true })
  }, [askKey, askAddress, importDone, id, navigate])

  if (apiQuery.isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    )
  }
  if (apiQuery.isError || !api) {
    return <QueryError error={apiQuery.error} onRetry={() => apiQuery.refetch()} title="Couldn't load API" />
  }

  const submitAddress = (e: FormEvent) => {
    e.preventDefault()
    setAddressError(null)
    if (!/^https?:\/\/.+/i.test(address.trim())) {
      setAddressError('Enter the address, starting with http:// or https://.')
      return
    }
    saveAddress.mutate()
  }

  const setupPath = `/apis/${id}/setup?${searchParams.toString()}`

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to={`/apis/${id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        {api.name}
      </Link>
      <PageHeader title={`Finish connecting ${api.name}`} description="One more thing and its tools are ready to use." />

      <Card>
        <CardContent className="space-y-6 pt-6">
          <div role="status" data-testid="import-status" className="text-sm">
            {importState.status === 'running' && (
              <p className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Reading the description. Big ones take a minute; it keeps going if you leave.
              </p>
            )}
            {importState.status === 'done' && job && (
              <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                Found {importState.operations} operation{importState.operations === 1 ? '' : 's'}
                {importState.tools > 0 ? ` and made ${importState.tools} tool${importState.tools === 1 ? '' : 's'}.` : '.'}
              </p>
            )}
            {importState.status === 'failed' && (
              <p className="text-destructive" role="alert">
                The import failed: {importState.error}{' '}
                <Link to={`/apis/${id}/import`} className="text-primary hover:underline">
                  Try another description
                </Link>
              </p>
            )}
          </div>

          {askAddress && (
            <section className="space-y-2" aria-labelledby="setup-address">
              <h2 id="setup-address" className="text-sm font-semibold">
                Its address
              </h2>
              {api.baseUrl ? (
                <p className="text-sm text-muted-foreground" data-testid="setup-address-done">
                  {api.baseUrl}
                </p>
              ) : (
                <form onSubmit={submitAddress} className="flex flex-wrap items-end gap-2" noValidate>
                  <div className="min-w-[16rem] flex-1">
                    <Label htmlFor="setup-address-input">Address</Label>
                    <Input
                      id="setup-address-input"
                      className="mt-1"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="https://api.example.com"
                      aria-invalid={addressError ? true : undefined}
                    />
                  </div>
                  <Button type="submit" disabled={saveAddress.isPending}>
                    Save address
                  </Button>
                  {addressError && (
                    <p role="alert" className="basis-full text-sm text-destructive">
                      {addressError}
                    </p>
                  )}
                </form>
              )}
            </section>
          )}

          {askKey && (
            <section className="space-y-2" aria-labelledby="setup-key">
              <h2 id="setup-key" className="text-sm font-semibold">
                Key
              </h2>
              {keyQuery.isError ? (
                <QueryError error={keyQuery.error} onRetry={() => keyQuery.refetch()} title="Couldn't load the key" />
              ) : !keyQuery.data ? (
                <LoadingSpinner />
              ) : keyQuery.data.source ? (
                <p className="flex items-center gap-2 text-sm" data-testid="setup-key-done">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
                  Saved. Tools send it with every call.
                </p>
              ) : (
                <ApiKeyForm
                  apiId={id}
                  apiName={api.name}
                  view={keyQuery.data}
                  returnTo={setupPath}
                  onSaved={(next) => queryClient.setQueryData(apiKeyQueryKey(id), next)}
                />
              )}
            </section>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        {everythingDone ? (
          <Button onClick={() => navigate(`/apis/${id}`)}>Open {api.name}</Button>
        ) : (
          <Button variant="ghost" onClick={() => navigate(`/apis/${id}`)}>
            Skip for now
          </Button>
        )}
      </div>
    </div>
  )
}
