import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { CredentialPicker } from '@/components/credentials/credential-picker'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { formatDate } from '@/lib/utils'

export type SignInMethod = 'api_key' | 'basic_auth' | 'company_signin' | 'jwt'
interface AuthConfig { id: string; type: string; isActive?: boolean; configuration: Record<string, any> }
const METHODS: { type: SignInMethod; label: string; hint: string }[] = [
  { type: 'api_key', label: 'Keys', hint: 'Create named keys, give them an expiry and revoke them when needed.' },
  { type: 'basic_auth', label: 'Usernames and passwords', hint: 'Keep a list of the people or systems allowed to sign in.' },
  { type: 'company_signin', label: 'Company sign-in', hint: 'Let people sign in with Google, Microsoft, Okta or Auth0.' },
  { type: 'jwt', label: 'Tokens from your own system', hint: 'Your system issues tokens; almyty checks who issued them and their signature.' },
]

/** The methods beneath Outside, protected, shared by gateways and agent APIs. */
export function GatewayAuthSection({ gatewayId, readOnly = false }: { gatewayId: string; gatewayName?: string; readOnly?: boolean }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<SignInMethod | null>(null)
  const [error, setError] = useState('')
  const auth = useQuery({ queryKey: ['gateway-auth-configs', gatewayId], queryFn: () => gatewaysApi.getAuthConfigs(gatewayId) })
  const companyMetadata = useQuery({ queryKey: ['gateway-company-signin-metadata', gatewayId], queryFn: () => gatewaysApi.getCompanySignInMetadata(gatewayId), enabled: editing === 'company_signin' })
  const raw = auth.data?.authConfigs ?? auth.data
  const configs: AuthConfig[] = Array.isArray(raw) ? raw : []
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['gateway-auth-configs', gatewayId] })
    queryClient.invalidateQueries({ queryKey: ['gateway', gatewayId] })
  }
  const save = useMutation({
    mutationFn: ({ type, configuration, isActive = true }: { type: SignInMethod; configuration?: Record<string, any>; isActive?: boolean }) => {
      const existing = configs.find(c => c.type === type)
      return existing
        ? gatewaysApi.updateAuthConfig(gatewayId, existing.id, { ...(configuration ? { configuration } : {}), isActive })
        : gatewaysApi.createAuthConfig(gatewayId, { type, configuration: configuration ?? {}, isActive })
    },
    onSuccess: () => { invalidate(); setEditing(null); setError('') },
    onError: err => setError(getApiErrorMessage(err, 'The method could not be saved.')),
  })
  return (
    <div className="space-y-4" data-testid="gateway-sign-in-methods">
      <p className="text-sm text-muted-foreground">Allow any combination. A caller only needs one of the enabled methods.</p>
      {auth.isError && <p role="alert" className="text-sm text-destructive">Sign-in methods could not be loaded. Reload to try again.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {METHODS.map(method => {
        const config = configs.find(c => c.type === method.type)
        const enabled = !!config && config.isActive !== false
        const open = editing === method.type
        return (
          <section key={method.type} className="space-y-4 rounded-lg border p-4">
            <div className="flex items-start justify-between gap-3">
              <label className="flex items-start gap-3">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" aria-label={method.label} checked={enabled || open}
                  disabled={readOnly || auth.isLoading || auth.isError || save.isPending}
                  onChange={event => {
                    setError('')
                    if (!event.target.checked) {
                      setEditing(null)
                      if (enabled) save.mutate({ type: method.type, isActive: false })
                    } else if (method.type === 'api_key') save.mutate({ type: method.type, configuration: config?.configuration ?? { keyHeader: 'x-api-key' } })
                    else setEditing(method.type)
                  }} />
                <span><span className="block text-sm font-medium">{method.label}</span><span className="block text-xs text-muted-foreground">{method.hint}</span></span>
              </label>
              {enabled && !readOnly && method.type !== 'api_key' && !open && <Button type="button" size="sm" variant="outline" onClick={() => setEditing(method.type)}>Edit {method.label.toLowerCase()}</Button>}
            </div>
            {method.type === 'api_key' && enabled && <GatewayKeys gatewayId={gatewayId} readOnly={readOnly} />}
            {method.type === 'basic_auth' && enabled && !open && <p className="text-sm text-muted-foreground">{config?.configuration.users?.filter((u: any) => u.isActive !== false).length ?? 0} usernames allowed</p>}
            {method.type === 'company_signin' && enabled && !open && <p className="text-sm text-muted-foreground">{config?.configuration.preset ?? 'Company'} sign-in is enabled.</p>}
            {open && <MethodForm key={`${method.type}-${config?.id ?? 'new'}`} type={method.type} configuration={{ ...config?.configuration, ...(method.type === 'company_signin' && companyMetadata.data?.redirectUri ? { redirectUri: companyMetadata.data.redirectUri } : {}) }} onCancel={() => setEditing(null)} saving={save.isPending}
              onSave={configuration => save.mutate({ type: method.type, configuration })} />}
          </section>
        )
      })}
    </div>
  )
}

function GatewayKeys({ gatewayId, readOnly }: { gatewayId: string; readOnly: boolean }) {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState('')
  const guard = useLeaveGuard(creating && (name !== '' || expiry !== ''))
  const query = useQuery({ queryKey: ['gateway-api-keys', gatewayId], queryFn: () => gatewaysApi.listApiKeys(gatewayId) })
  const keys = Array.isArray(query.data) ? query.data : Array.isArray(query.data?.keys) ? query.data.keys : []
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['gateway-api-keys', gatewayId] })
  const create = useMutation({
    mutationFn: () => gatewaysApi.generateApiKey(gatewayId, { name: name.trim(), ...(expiry ? { expiresAt: `${expiry}T23:59:59.999Z` } : {}) }),
    onSuccess: result => { setSecret(result.key); setCreating(false); setName(''); setExpiry(''); setError(''); invalidate() },
    onError: err => setError(getApiErrorMessage(err)),
  })
  const revoke = useMutation({ mutationFn: (id: string) => gatewaysApi.revokeApiKey(gatewayId, id), onSuccess: invalidate, onError: err => setError(getApiErrorMessage(err)) })
  return (
    <div className="space-y-3">
      {!readOnly && !creating && <Button type="button" size="sm" variant="outline" onClick={() => { setCreating(true); setSecret(null) }}>New key</Button>}
      {creating && <form aria-label="New key" className="space-y-3" onSubmit={event => { event.preventDefault(); if (name.trim()) create.mutate(); else setError('Give the key a name.') }}>
        <Field id={`key-name-${gatewayId}`} label="Name"><Input value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></Field>
        <Field id={`key-expiry-${gatewayId}`} label="Expires on" hint="Leave empty to keep it until you revoke it."><Input type="date" value={expiry} onChange={event => setExpiry(event.target.value)} /></Field>
        <InlineFormActions onCancel={() => setCreating(false)} submitLabel="Make key" submitting={create.isPending} />
      </form>}
      {secret && <div data-testid="generated-api-key" className="space-y-3 rounded-lg border bg-muted p-4">
        <CopyField value={secret} label="API key" />
        <p className="text-sm">Copy it now. You won't see it again.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => setSecret(null)}>I've saved it</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {query.isError && <p role="alert" className="text-sm text-destructive">Keys could not be loaded.</p>}
      {!query.isLoading && !query.isError && !keys.length && <p className="text-sm text-muted-foreground">No keys yet.</p>}
      {guard.element}
      <ul className="space-y-2" aria-label="Keys">{keys.map((key: any) => <li key={key.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2">
        <div><span className="text-sm font-medium">{key.name}</span><code className="ml-2 text-xs">{key.keyPrefix}…</code></div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>{key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : 'Never used'}</span>
          <span>{key.expiresAt ? `Expires ${formatDate(key.expiresAt)}` : 'No expiry'}</span>
          <span>{key.isActive === false ? 'Revoked' : ''}</span>
          {!readOnly && key.isActive !== false && <Button type="button" variant="ghost" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(key.id)}>Revoke {key.name}</Button>}
        </div>
      </li>)}</ul>
    </div>
  )
}

interface ManagedUser { id?: string; username: string; password?: string; isActive: boolean }
function MethodForm({ type, configuration, onSave, onCancel, saving }: { type: SignInMethod; configuration: Record<string, any>; onSave: (config: Record<string, any>) => void; onCancel: () => void; saving: boolean }) {
  const [values, setValues] = useState<Record<string, any>>({ preset: 'google', ...configuration })
  const [users, setUsers] = useState<ManagedUser[]>(configuration.users?.map((u: any) => ({ id: u.id, username: u.username, isActive: u.isActive !== false })) ?? [{ username: '', password: '', isActive: true }])
  const [error, setError] = useState('')
  const initialValues = { preset: 'google', ...configuration }
  const initialUsers = configuration.users?.map((u: any) => ({ id: u.id, username: u.username, isActive: u.isActive !== false })) ?? [{ username: '', password: '', isActive: true }]
  const guard = useLeaveGuard(JSON.stringify(values) !== JSON.stringify(initialValues) || JSON.stringify(users) !== JSON.stringify(initialUsers))
  const label = METHODS.find(method => method.type === type)!.label.toLowerCase()
  const set = (key: string, value: any) => setValues(old => ({ ...old, [key]: value }))
  const input = (key: string, label: string, hint?: string, secret = false) => <Field key={key} id={`signin-${type}-${key}`} label={label} hint={hint}><Input type={secret ? 'password' : 'text'} value={values[key] ?? ''} onChange={event => set(key, event.target.value)} autoComplete={secret ? 'new-password' : 'off'} /></Field>
  const list = (key: string, label: string, hint: string) => <Field id={`signin-${type}-${key}`} label={label} hint={hint}><Input value={Array.isArray(values[key]) ? values[key].join(', ') : values[key] ?? ''} onChange={event => set(key, event.target.value)} /></Field>
  const submit = () => {
    if (type === 'basic_auth') {
      if (!users.length || users.some(user => !user.username.trim() || (!user.id && !user.password))) { setError('Give every username a name and password.'); return }
      onSave({ users: users.map(user => ({ ...user, username: user.username.trim(), ...(user.password ? {} : { password: undefined }) })) }); return
    }
    if (type === 'company_signin' && (!values.clientId || (!values.hasClientSecret && !values.clientSecret))) { setError('Enter the client ID and secret for your sign-in application.'); return }
    if (type === 'jwt' && (!values.issuer || !values.jwksUrl || !values.audience)) { setError('Open Advanced and enter the issuer, signing keys address and audience.'); return }
    const out = { ...values }
    delete out.hasClientSecret; delete out.redirectUri; delete out.credentialId
    if (!out.clientSecret) delete out.clientSecret
    for (const key of ['allowedEmailDomains', 'allowedGroups']) if (typeof out[key] === 'string') out[key] = out[key].split(',').map((value: string) => value.trim()).filter(Boolean)
    if (type === 'company_signin' && out.preset === 'google' && out.allowedGroups?.length && (!out.directoryCredentialId || !out.directoryAdminEmail)) { setError('Choose a Google directory credential and enter its delegated administrator email to check groups.'); return }
    if (type === 'jwt') delete out.preset
    onSave(out)
  }
  return <form className="space-y-4" aria-label={`Configure ${label}`} onSubmit={event => { event.preventDefault(); submit() }}>
    {type === 'basic_auth' && <>
      {users.map((user, index) => <div key={user.id ?? index} className="space-y-3 rounded border p-3">
        <Field id={`signin-user-${index}`} label={index === 0 ? 'Username' : `Username ${index + 1}`}><Input value={user.username} onChange={event => setUsers(old => old.map((row, i) => i === index ? { ...row, username: event.target.value } : row))} autoComplete="off" /></Field>
        <Field id={`signin-password-${index}`} label={index === 0 ? 'Password' : `Password ${index + 1}`} hint={user.id ? 'Leave empty to keep the current password.' : undefined}><Input type="password" value={user.password ?? ''} onChange={event => setUsers(old => old.map((row, i) => i === index ? { ...row, password: event.target.value } : row))} autoComplete="new-password" /></Field>
        <Button type="button" size="sm" variant="ghost" onClick={() => setUsers(old => old.filter((_, i) => i !== index))}>Remove username {user.username || index + 1}</Button>
      </div>)}
      <Button type="button" size="sm" variant="outline" onClick={() => setUsers(old => [...old, { username: '', password: '', isActive: true }])}>Add username</Button>
    </>}
    {type === 'company_signin' && <>
      <div className="space-y-1"><Label htmlFor="company-provider">Provider</Label><Select value={values.preset} onValueChange={preset => set('preset', preset)}><SelectTrigger id="company-provider"><SelectValue /></SelectTrigger><SelectContent>{[['google', 'Google'], ['microsoft', 'Microsoft'], ['okta', 'Okta'], ['auth0', 'Auth0']].map(([value, name]) => <SelectItem key={value} value={value}>{name}</SelectItem>)}</SelectContent></Select></div>
      {values.preset === 'microsoft' && input('tenant', 'Microsoft directory', 'Your directory ID or verified domain.')}
      {['okta', 'auth0'].includes(values.preset) && input('issuer', 'Company sign-in address', 'The issuer address from your provider.')}
      {input('clientId', 'Client ID')}{input('clientSecret', 'Client secret', values.hasClientSecret ? 'Leave empty to keep the saved secret.' : undefined, true)}
      {list('allowedEmailDomains', 'Allowed email domains', 'Optional, separated by commas. Leave empty to allow every domain.')}
      {list('allowedGroups', 'Allowed groups', 'Optional group names or IDs, separated by commas.')}
      {values.preset === 'google' && (Array.isArray(values.allowedGroups) ? values.allowedGroups.length > 0 : Boolean(values.allowedGroups?.trim())) && <>
        <CredentialPicker id="company-directory-credential" label="Google directory credential" kind="cloud" connectorKey="gcp" value={values.directoryCredentialId ?? ''} onChange={credential => set('directoryCredentialId', credential?.id ?? '')} hint="Use a Google service account with Workspace domain-wide delegation for reading group membership." />
        {input('directoryAdminEmail', 'Delegated administrator email', 'A Workspace administrator the service account may act as.')}
      </>}
      <Disclosure title="Advanced" summary="Sign-in settings">
        {values.preset !== 'google' && input('groupsClaim', 'Groups claim', 'Usually groups. Your provider must include it in the signed token.')}
        {values.preset === 'google' && <p className="text-xs text-muted-foreground">Google domain restrictions require a verified Workspace domain. Groups are checked through Google Directory.</p>}
        {configuration.redirectUri && <CopyField value={configuration.redirectUri} label="Callback address" />}
        <p className="text-xs text-muted-foreground">Register the callback address with your provider. Only verified email addresses can satisfy a domain restriction.</p>
      </Disclosure>
    </>}
    {type === 'jwt' && <Disclosure title="Advanced" summary="Issuer, signing keys and audience">
      {input('issuer', 'Issuer', 'The exact issuer in tokens your system creates.')}
      {input('jwksUrl', 'Signing keys address', 'The HTTPS address of your JSON Web Key Set.')}
      {input('audience', 'Audience', 'The audience your system puts in tokens for this endpoint.')}
    </Disclosure>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <InlineFormActions onCancel={onCancel} submitLabel={`Save ${label}`} submitting={saving} />
    {guard.element}
  </form>
}
