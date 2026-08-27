import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { credentialsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'

export interface SigningCredentialDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 'apple' asks for notarisation keys as well; 'authenticode' does not. */
  kind: 'apple' | 'authenticode'
  onCreated: (credentialId: string) => void
}

/** The largest certificate worth accepting. A .p12 is a few kilobytes. */
const MAX_CERTIFICATE_BYTES = 512 * 1024

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

/**
 * Adding the certificate a customer's apps are signed with.
 *
 * The private key goes straight into the credential vault and is never
 * read back: the field is write-only from here on, the same as every
 * other secret in the product.
 */
export function SigningCredentialDialog({
  open,
  onOpenChange,
  kind,
  onCreated,
}: SigningCredentialDialogProps) {
  const { success, error: errorNotif } = useNotifications()
  const fileRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [apiKeyId, setApiKeyId] = useState('')
  const [apiIssuer, setApiIssuer] = useState('')
  const [apiKey, setApiKey] = useState('')

  const apple = kind === 'apple'

  const create = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a certificate file.')
      if (file.size > MAX_CERTIFICATE_BYTES) {
        throw new Error('That file is too large to be a signing certificate.')
      }

      const certificate = await readAsBase64(file)
      const response = await credentialsApi.create({
        name,
        type: 'code_signing',
        config: {
          certificate,
          certificatePassword: password,
          ...(apple
            ? { appleApiKeyId: apiKeyId, appleApiIssuer: apiIssuer, appleApiKey: apiKey }
            : {}),
        },
      })
      return (response as any)?.data ?? response
    },
    onSuccess: (credential: any) => {
      success('Certificate stored', 'Builds for this distribution can be signed with it.')
      onCreated(credential.id)
      onOpenChange(false)
    },
    onError: (err: any) =>
      errorNotif(
        'Could not store it',
        err?.response?.data?.message || err?.message || 'Something went wrong.',
      ),
  })

  const ready =
    name.trim() && file && password && (!apple || (apiKeyId && apiIssuer && apiKey))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a signing certificate</DialogTitle>
          <DialogDescription>
            {apple
              ? 'Your Developer ID certificate and an App Store Connect key. Apps built here are signed and notarised as you.'
              : 'Your code-signing certificate. Apps built here are signed as you.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="signing-name">Name</Label>
            <Input
              id="signing-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={apple ? 'Developer ID' : 'Code signing'}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="signing-file">
              Certificate ({apple ? '.p12' : '.pfx or .p12'})
            </Label>
            <Input
              id="signing-file"
              ref={fileRef}
              type="file"
              accept=".p12,.pfx"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">
              Stored encrypted and never shown again. Whoever holds it can sign software
              as you, so it is treated like a password.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="signing-password">Certificate password</Label>
            <Input
              id="signing-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {apple && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="signing-key-id">App Store Connect key id</Label>
                <Input
                  id="signing-key-id"
                  value={apiKeyId}
                  onChange={(e) => setApiKeyId(e.target.value)}
                  placeholder="ABCD1234EF"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signing-issuer">Issuer id</Label>
                <Input
                  id="signing-issuer"
                  value={apiIssuer}
                  onChange={(e) => setApiIssuer(e.target.value)}
                  placeholder="69a6de70-..."
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signing-key">Private key (.p8 contents)</Label>
                <Textarea
                  id="signing-key"
                  rows={4}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  Notarisation needs this. Without it macOS still warns on download, even
                  though the app is signed.
                </p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Storing...' : 'Store certificate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
