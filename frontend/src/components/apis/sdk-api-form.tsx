/**
 * apis/sdk-api-form -- `/apis/new/sdk`: an API made of npm packages. Their
 * exports are analysed on the server and become tools. Reached from
 * "Other ways" on Connect an API.
 */
import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, XCircle } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SecretInput } from '@/components/ui/secret-input'
import { Textarea } from '@/components/ui/textarea'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'

export function SdkApiForm() {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()

  const [name, setName] = React.useState('')
  const [nameError, setNameError] = React.useState<string | undefined>()
  const [description, setDescription] = React.useState('')
  const [packages, setPackages] = React.useState<Array<{ name: string; version: string }>>([])
  const [packagesError, setPackagesError] = React.useState<string | undefined>()
  const [newPkgName, setNewPkgName] = React.useState('')
  const [newPkgVersion, setNewPkgVersion] = React.useState('*')
  const [usePrivateRegistry, setUsePrivateRegistry] = React.useState(false)
  const [registryUrl, setRegistryUrl] = React.useState('')
  const [registryToken, setRegistryToken] = React.useState('')
  const [registryScope, setRegistryScope] = React.useState('')
  const [visibility, setVisibility] = React.useState<VisibilityValue>({ visibility: 'org', teamId: null })

  const guard = useLeaveGuard(name !== '' || description !== '' || packages.length > 0 || usePrivateRegistry)

  const create = useMutation({
    mutationFn: (data: any) => apisApi.createSdkApi(data),
    onSuccess: (response: any) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API created', 'Its packages are being analysed.')
      guard.leave(response?.id ? `/apis/${response.id}` : '/apis')
    },
    onError: (err: any) => error('Failed to create the API', getApiErrorMessage(err, 'Please try again.')),
  })

  const addPackage = () => {
    if (!newPkgName.trim()) return
    setPackages([...packages, { name: newPkgName.trim(), version: newPkgVersion }])
    setNewPkgName('')
    setNewPkgVersion('*')
    setPackagesError(undefined)
  }

  const submit = () => {
    let bad = false
    if (name.trim().length < 2) {
      setNameError('Name must be at least 2 characters')
      bad = true
    }
    if (packages.length === 0) {
      setPackagesError('Add at least one npm package.')
      bad = true
    }
    if (bad) return
    const dependencies: Record<string, string> = {}
    packages.forEach((pkg) => {
      dependencies[pkg.name] = pkg.version
    })
    create.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      dependencies,
      visibility: visibility.visibility,
      teamId: visibility.teamId,
      ...(usePrivateRegistry
        ? { npmRegistry: { url: registryUrl || undefined, token: registryToken || undefined, scope: registryScope || undefined } }
        : {}),
    })
  }

  return (
    <FormPage
      title="Import an npm package"
      description="Its exported functions become tools your agents can call."
      back={{ to: '/apis/new', label: 'Connect an API' }}
      guard={guard}
      onSubmit={submit}
      submitLabel="Create API"
      submitting={create.isPending}
    >
      <FormSection title="Packages">
        <Field id="sdk-name" label="Name" error={nameError} required>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setNameError(undefined)
            }}
            placeholder="e.g. AWS S3"
          />
        </Field>
        <Field
          id="sdk-package-name"
          label="Packages"
          hint={packages.length === 0 ? 'Add at least one npm package.' : undefined}
          error={packagesError}
        >
          <div id="sdk-packages" className="rounded-lg border">
            {packages.length > 0 && (
              <div className="divide-y">
                {packages.map((pkg, idx) => (
                  <div key={idx} className="flex items-center gap-2 p-2">
                    <div className="min-w-0 flex-1 truncate font-mono text-sm">{pkg.name}</div>
                    <div className="w-24 text-sm text-muted-foreground">{pkg.version}</div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={`Remove ${pkg.name}`}
                      onClick={() => setPackages(packages.filter((_, i) => i !== idx))}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 border-t p-2 first:border-t-0">
              <Input
                id="sdk-package-name"
                aria-label="Package name"
                placeholder="Package name (e.g. @aws-sdk/client-s3)"
                value={newPkgName}
                onChange={(e) => setNewPkgName(e.target.value)}
                className="h-8 min-w-0 flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addPackage()
                  }
                }}
              />
              <Input
                aria-label="Package version"
                placeholder="Version"
                value={newPkgVersion}
                onChange={(e) => setNewPkgVersion(e.target.value)}
                className="h-8 w-20 sm:w-32"
              />
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" aria-label="Add package" onClick={addPackage}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </Field>

        <div className="flex items-center space-x-2">
          <Checkbox id="private-registry" checked={usePrivateRegistry} onCheckedChange={(checked) => setUsePrivateRegistry(checked === true)} />
          <Label htmlFor="private-registry" className="cursor-pointer text-sm font-normal">
            Use a private npm registry
          </Label>
        </div>
        {usePrivateRegistry && (
          <div className="grid grid-cols-1 gap-4 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
            <Field id="registry-url" label="Registry URL" className="sm:col-span-2">
              <Input placeholder="https://registry.example.com" value={registryUrl} onChange={(e) => setRegistryUrl(e.target.value)} />
            </Field>
            <Field id="registry-token" label="Auth token" hint="An npm token with read access to the registry.">
              <SecretInput placeholder="npm auth token" value={registryToken} onChange={(e) => setRegistryToken(e.target.value)} />
            </Field>
            <Field id="registry-scope" label="Scope (optional)">
              <Input placeholder="@myorg" value={registryScope} onChange={(e) => setRegistryScope(e.target.value)} />
            </Field>
          </div>
        )}

        <Field id="sdk-description" label="Description (optional)">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </FormSection>

      <FormSection title="Who can use it">
        <VisibilityField organizationId={currentOrganization?.id ?? ''} value={visibility} onChange={setVisibility} noun="this API" />
      </FormSection>
    </FormPage>
  )
}
