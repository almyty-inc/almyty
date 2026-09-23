/**
 * /credentials/new -- store one secret in the vault.
 *
 * The fields follow the type: a single value for API keys, bearer tokens
 * and JWTs, a username and password for basic auth, a client id and
 * secret for OAuth2, nothing extra for a custom credential.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { credentialConfig, createCredentialSchema } from '@/components/credentials/schema'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { credentialsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'

export const SECRET_TYPES = [
  { value: 'api_key', label: 'API key' },
  { value: 'bearer_token', label: 'Bearer token' },
  { value: 'basic_auth', label: 'Basic auth' },
  { value: 'oauth2', label: 'OAuth2' },
  { value: 'jwt', label: 'JWT' },
  { value: 'custom', label: 'Custom' },
]

/** A blank credential form, whatever type it ends up being. */
export const EMPTY_CREDENTIAL_FORM = {
  name: '',
  type: 'api_key',
  description: '',
  value: '',
  username: '',
  password: '',
  clientId: '',
  clientSecret: '',
}

type CredentialForm = typeof EMPTY_CREDENTIAL_FORM

const VALUE_LABELS: Record<string, string> = {
  api_key: 'API key',
  bearer_token: 'Token',
  jwt: 'JWT',
}

export function CreateCredentialForm() {
  const qc = useQueryClient()
  const notify = useNotifications()
  const { currentOrganization } = useOrganizationStore()
  const [form, setForm] = useState<CredentialForm>(EMPTY_CREDENTIAL_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })

  const dirty = (Object.keys(form) as Array<keyof CredentialForm>).some((k) => form[k] !== EMPTY_CREDENTIAL_FORM[k])
  const guard = useLeaveGuard(dirty)

  const set = (key: keyof CredentialForm, value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (errors[key]) setErrors((e) => ({ ...e, [key]: '' }))
  }

  const createMut = useMutation({
    mutationFn: (data: Record<string, unknown>) => credentialsApi.create(data as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credentials'] })
      notify.success('Credential created', `"${form.name}" is now in the vault.`)
      guard.leave('/credentials')
    },
    onError: (err) => notify.error('Error', getApiErrorMessage(err, 'Failed to create credential')),
  })

  const submit = () => {
    const parsed = createCredentialSchema.safeParse(form)
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'name')
        if (!next[key]) next[key] = issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    // Backend's CreateCredentialDto expects { name, type, description?, config: object, visibility, teamId? }.
    // The legacy flat 'value' shape is rejected by forbidNonWhitelisted.
    createMut.mutate({
      name: form.name,
      type: form.type,
      description: form.description,
      config: credentialConfig(form),
      visibility: visibility.visibility,
      teamId: visibility.teamId,
    })
  }

  const singleValue = form.type in VALUE_LABELS

  return (
    <FormPage
      title="Add credential"
      description="Store a credential securely in the vault. Values are encrypted and never shown again."
      back={{ to: '/credentials', label: 'Credentials' }}
      guard={guard}
      onSubmit={submit}
      submitLabel="Create credential"
      submitting={createMut.isPending}
      width="narrow"
    >
      <FormSection>
        <Field id="credential-name" label="Name" required error={errors.name}>
          <Input placeholder="e.g. Stripe API key" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field id="credential-type" label="Type" required>
          <Select value={form.type} onValueChange={(v) => set('type', v)}>
            <SelectTrigger id="credential-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SECRET_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        {singleValue && (
          <Field
            id="credential-value"
            label={VALUE_LABELS[form.type]}
            required
            error={errors.value}
            hint="Paste it from the provider's dashboard. It is encrypted and cannot be read back."
          >
            <SecretInput placeholder="Enter value..." value={form.value} onChange={(e) => set('value', e.target.value)} />
          </Field>
        )}
        {form.type === 'basic_auth' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="credential-username" label="Username" required error={errors.username}>
              <SecretInput masked={false} placeholder="Username" value={form.username} onChange={(e) => set('username', e.target.value)} />
            </Field>
            <Field id="credential-password" label="Password" required error={errors.password}>
              <SecretInput placeholder="Password" value={form.password} onChange={(e) => set('password', e.target.value)} />
            </Field>
          </div>
        )}
        {form.type === 'oauth2' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="credential-client-id" label="Client ID" required error={errors.clientId} hint="From the OAuth app you registered with the provider.">
              <SecretInput masked={false} placeholder="Client ID" value={form.clientId} onChange={(e) => set('clientId', e.target.value)} />
            </Field>
            <Field id="credential-client-secret" label="Client secret" required error={errors.clientSecret}>
              <SecretInput placeholder="Client secret" value={form.clientSecret} onChange={(e) => set('clientSecret', e.target.value)} />
            </Field>
          </div>
        )}
        <Field id="credential-description" label="Description" error={errors.description}>
          <Input placeholder="Optional description" value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
      </FormSection>
      <FormSection title="Who can use it">
        <VisibilityField
          organizationId={currentOrganization?.id ?? ''}
          value={visibility}
          onChange={setVisibility}
          noun="this credential"
        />
      </FormSection>
    </FormPage>
  )
}
