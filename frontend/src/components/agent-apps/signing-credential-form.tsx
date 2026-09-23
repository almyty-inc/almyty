import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { SECRET_INPUT_ATTRS, SecretInput } from '@/components/ui/secret-input'
import { Textarea } from '@/components/ui/textarea'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { credentialsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
import { DISTRIBUTION_LABELS, agentAppsApi, type DistributionTarget } from '@/lib/agent-apps'

export type SigningKind = 'apple' | 'authenticode'

/** The largest certificate worth accepting. A .p12 is a few kilobytes. */
export const MAX_CERTIFICATE_BYTES = 512 * 1024

const readAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.onload = () => {
      // FileReader gives "data:<type>;base64,<payload>"; the API stores
      // the payload alone.
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })

type Errors = Partial<Record<'name' | 'file' | 'password' | 'keyId' | 'issuer' | 'key', string>>

export interface SigningCredentialFormProps {
  slug: string
  appName: string
  target: DistributionTarget
  /** 'apple' asks for notarisation keys as well; 'authenticode' does not. */
  kind: SigningKind
}

/**
 * Adding the certificate an app's builds are signed with, then signing
 * this distribution with it.
 *
 * The private key goes straight into the credential vault and is never
 * read back: the fields are write-only from here on, the same as every
 * other secret in the product.
 */
export function SigningCredentialForm({ slug, appName, target, kind }: SigningCredentialFormProps) {
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()
  const apple = kind === 'apple'
  const back = `/apps/${slug}/distributions/${target}`

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [apiKeyId, setApiKeyId] = useState('')
  const [apiIssuer, setApiIssuer] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [errors, setErrors] = useState<Errors>({})

  const guard = useLeaveGuard(!!(name || password || file || apiKeyId || apiIssuer || apiKey))

  const create = useMutation({
    mutationFn: async () => {
      const certificate = await readAsBase64(file!)
      const response = await credentialsApi.create({
        name: name.trim(),
        type: 'code_signing',
        config: {
          certificate,
          certificatePassword: password,
          ...(apple
            ? { appleApiKeyId: apiKeyId.trim(), appleApiIssuer: apiIssuer.trim(), appleApiKey: apiKey }
            : {}),
        },
      })
      const credential = (response as any)?.data ?? response
      // Sign this distribution with it straight away: that is why the
      // certificate was added from here.
      await agentAppsApi.addDistribution(slug, target, { signingCredentialId: credential.id })
      return credential
    },
    onSuccess: () => {
      success('Certificate stored', `${DISTRIBUTION_LABELS[target]} builds are signed with it.`)
      // Into the cache before the picker reads it again: without a row
      // for this id the Select fell back to "Nothing, ship it unsigned"
      // for a build that would in fact be signed.
      queryClient.invalidateQueries({ queryKey: ['signing-credentials'] })
      queryClient.invalidateQueries({ queryKey: ['agent-app', slug] })
      guard.leave(back)
    },
    onError: (err: unknown) =>
      errorNotif('Could not store the certificate', getApiErrorMessage(err, 'Please try again.')),
  })

  const validate = (): Errors => {
    const next: Errors = {}
    if (!name.trim()) next.name = 'Give the certificate a name.'
    if (!file) next.file = 'Choose the certificate file.'
    else if (file.size > MAX_CERTIFICATE_BYTES) next.file = 'That file is too large to be a signing certificate.'
    if (!password) next.password = 'Enter the password the certificate was exported with.'
    if (apple) {
      if (!apiKeyId.trim()) next.keyId = 'Enter the key ID.'
      if (!apiIssuer.trim()) next.issuer = 'Enter the issuer ID.'
      if (!apiKey.trim()) next.key = 'Paste the contents of the .p8 file.'
    }
    return next
  }

  return (
    <FormPage
      title="Add a signing certificate"
      description={
        apple
          ? 'Your Developer ID certificate and an App Store Connect key. Apps built here are signed and notarised as you.'
          : 'Your code-signing certificate. Apps built here are signed as you.'
      }
      back={{ to: back, label: `${appName} · ${DISTRIBUTION_LABELS[target]}` }}
      guard={guard}
      width="narrow"
      submitLabel="Store certificate"
      submitting={create.isPending}
      onSubmit={() => {
        const next = validate()
        setErrors(next)
        if (Object.keys(next).length === 0) create.mutate()
      }}
    >
      <FormSection
        title="Certificate"
        description="Stored encrypted and never shown again. Whoever holds it can sign software as you, so it is treated like a password."
      >
        <Field
          id="signing-name"
          label="Name"
          required
          hint="Only your team sees this. It tells certificates apart in the Sign with list."
          error={errors.name}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={apple ? 'Developer ID' : 'Code signing'}
            autoComplete="off"
          />
        </Field>

        <Field
          id="signing-file"
          label={`Certificate file (${apple ? '.p12' : '.pfx or .p12'})`}
          required
          hint={
            apple
              ? 'Keychain Access → My Certificates → your Developer ID Application certificate → Export, as .p12.'
              : 'Export it with its private key from your certificate provider or the Windows certificate store, as .pfx.'
          }
          error={errors.file}
        >
          <Input
            type="file"
            accept=".p12,.pfx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>

        <Field
          id="signing-password"
          label="Certificate password"
          required
          hint="The password you set when you exported the file."
          error={errors.password}
        >
          <SecretInput value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </FormSection>

      {apple && (
        <FormSection
          title="Notarisation"
          description="Without these macOS still warns on download, even though the app is signed."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="signing-key-id"
              label="App Store Connect key ID"
              required
              hint="App Store Connect → Users and Access → Integrations → App Store Connect API, in the key's row."
              error={errors.keyId}
            >
              <SecretInput
                masked={false}
                value={apiKeyId}
                onChange={(e) => setApiKeyId(e.target.value)}
                placeholder="ABCD1234EF"
              />
            </Field>
            <Field
              id="signing-issuer"
              label="Issuer ID"
              required
              hint="Shown above the key list on the same App Store Connect page."
              error={errors.issuer}
            >
              <SecretInput
                masked={false}
                value={apiIssuer}
                onChange={(e) => setApiIssuer(e.target.value)}
                placeholder="69a6de70-..."
              />
            </Field>
          </div>
          <Field
            id="signing-key"
            label="Private key (.p8 contents)"
            required
            hint="Open the .p8 file downloaded when the key was created and paste everything in it. Apple lets you download it only once."
            error={errors.key}
          >
            <Textarea
              {...SECRET_INPUT_ATTRS}
              rows={5}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="-----BEGIN PRIVATE KEY-----"
              className="font-mono text-xs"
            />
          </Field>
        </FormSection>
      )}
    </FormPage>
  )
}
