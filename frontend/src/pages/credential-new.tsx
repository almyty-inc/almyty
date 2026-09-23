import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { credentialsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { SECRET_TYPES, credentialConfig, createCredentialSchema } from '@/components/credentials/schema'

/** A blank credential form, whatever type it ends up being. */
const EMPTY_CREDENTIAL_FORM = {
  name: '', type: 'api_key', description: '', value: '',
  username: '', password: '', clientId: '', clientSecret: '',
}

/**
 * Add a vault credential: a page of its own (/credentials/new), not a
 * modal. Private ("just me") makes it the creator's personal credential:
 * nobody else sees or uses it, org admins included.
 */
export function CredentialNewPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const notify = useNotifications()
  const { currentOrganization } = useOrganizationStore()
  const [form, setForm] = useState(EMPTY_CREDENTIAL_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })

  useEffect(() => {
    document.title = 'Add credential | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const createMut = useMutation({
    mutationFn: (data: any) => credentialsApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credentials'] })
      notify.success('Credential created', `"${form.name}" is now in the vault.`)
      navigate('/credentials')
    },
    onError: (err) => notify.error('Error', getApiErrorMessage(err, 'Failed to create credential')),
  })

  const submit = () => {
    const parsed = createCredentialSchema.safeParse(form)
    if (!parsed.success) {
      setFormError(parsed.error.issues[0].message)
      return
    }
    setFormError(null)
    // The backend's CreateCredentialDto expects { name, type, description?,
    // config: object, visibility, teamId? }; a flat 'value' is rejected.
    createMut.mutate({
      name: form.name,
      type: form.type,
      description: form.description,
      config: credentialConfig(form),
      visibility: visibility.visibility,
      teamId: visibility.teamId,
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/credentials" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Credentials
        </Link>
      </div>

      <div>
        <h1 className={DETAIL_TITLE_CLASSES}>Add credential</h1>
        <p className="text-sm text-muted-foreground mt-1">Store a credential securely in the vault.</p>
      </div>

      <Card className="max-w-2xl">
        <CardContent className="pt-6 space-y-4">
          <div><label className="text-sm font-medium" htmlFor="credential-name">Name</label>
            <Input id="credential-name" placeholder="e.g. Stripe API Key" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
          <div><label className="text-sm font-medium">Type</label>
            <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
              <SelectTrigger aria-label="Type"><SelectValue /></SelectTrigger>
              <SelectContent>{SECRET_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select></div>
          {(form.type === 'api_key' || form.type === 'bearer_token' || form.type === 'jwt') && (
            <div><label className="text-sm font-medium" htmlFor="credential-value">{form.type === 'api_key' ? 'API Key' : form.type === 'bearer_token' ? 'Token' : 'JWT Token'}</label>
              <Input id="credential-value" type="password" placeholder="Enter value..." value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} /></div>
          )}
          {form.type === 'basic_auth' && (<>
            <div><label className="text-sm font-medium">Username</label>
              <Input placeholder="Username" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} /></div>
            <div><label className="text-sm font-medium">Password</label>
              <Input type="password" placeholder="Password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} /></div>
          </>)}
          {form.type === 'oauth2' && (<>
            <div><label className="text-sm font-medium">Client ID</label>
              <Input placeholder="Client ID" value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} /></div>
            <div><label className="text-sm font-medium">Client Secret</label>
              <Input type="password" placeholder="Client Secret" value={form.clientSecret} onChange={e => setForm(f => ({ ...f, clientSecret: e.target.value }))} /></div>
          </>)}
          <div><label className="text-sm font-medium">Description</label>
            <Input placeholder="Optional description" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></div>
          <div className="border-t pt-4">
            <VisibilityField
              organizationId={currentOrganization?.id ?? ''}
              value={visibility}
              onChange={setVisibility}
              noun="this credential"
            />
          </div>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => navigate('/credentials')}>Cancel</Button>
            <Button disabled={!form.name || createMut.isPending} onClick={submit}>
              {createMut.isPending ? 'Creating...' : 'Create credential'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
