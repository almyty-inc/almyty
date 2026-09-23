import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EntitlementGate } from '@/components/entitlement-gate'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { UpgradePrompt } from '@/components/plan-indicator'
import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useConfirm } from '@/components/ui/confirm-dialog'

/**
 * Customer-managed encryption keys.
 *
 * Every secret almyty holds is envelope-encrypted under a data key. This
 * attaches YOUR key to wrap it, so the platform can be made unable to
 * read your credentials by taking the key away.
 *
 * The backend has been complete and unreachable. The two things this
 * surface must not get wrong are saying plainly what turning it off does
 * not do, and never implying the key material passes through here — it
 * does not, an ARN is a reference.
 */
const FEATURE = 'byo_kms'

interface KmsConfig {
  enabled: boolean
  cmkArn: string | null
  awsRegion: string | null
  provisioned: boolean
  updatedAt: string | null
}

export function KmsSettings() {
  return (
    <EntitlementGate
      feature={FEATURE}
      mode="lock"
      fallback={
        <UpgradePrompt
          feature={FEATURE}
          title="Customer-managed keys"
          description="Wrap every stored secret under a KMS key in your own AWS account, so access can be revoked by you rather than by us."
        />
      }
    >
      <Kms />
    </EntitlementGate>
  )
}

function Kms() {
  const queryClient = useQueryClient()
  const [cmkArn, setCmkArn] = useState('')
  const [awsRegion, setAwsRegion] = useState('')

  const config = useQuery({
    queryKey: ['kms-config'],
    queryFn: async () => (await api.get('/kms')).data.data as KmsConfig,
  })

  // Prefilled from what is stored, so replacing a key is an edit rather
  // than a retype of something the person may not have to hand.
  useEffect(() => {
    if (config.data) {
      setCmkArn((prev) => prev || config.data.cmkArn || '')
      setAwsRegion((prev) => prev || config.data.awsRegion || '')
    }
  }, [config.data])

  /**
   * First attach only. The server answers a re-attach with 409 and tells
   * you to rotate, because attaching twice used to mint a second data
   * key and overwrite the first — leaving every secret sealed under the
   * old one unreadable, silently.
   */
  const attach = useMutation({
    mutationFn: async () =>
      (await api.put('/kms', { cmkArn: cmkArn.trim(), awsRegion: awsRegion.trim(), enabled: true })).data.data as KmsConfig,
    onSuccess: (data) => queryClient.setQueryData(['kms-config'], data),
  })

  /**
   * Rotation is its own operation, and this is the only way to reach it.
   * It retains the outgoing wrapped key, so everything sealed under it
   * stays readable — which is the whole difference from re-attaching.
   */
  const rotate = useMutation({
    mutationFn: async () =>
      (await api.post('/kms/rotate', { cmkArn: cmkArn.trim() || undefined, awsRegion: awsRegion.trim() || undefined }))
        .data.data as KmsConfig,
    onSuccess: (data) => queryClient.setQueryData(['kms-config'], data),
  })

  const setEnabled = useMutation({
    mutationFn: async (enabled: boolean) => (await api.put('/kms/enabled', { enabled })).data.data as KmsConfig,
    onSuccess: (data) => queryClient.setQueryData(['kms-config'], data),
  })

  const data = config.data
  // An ARN, not a key. Checked here so a mistyped value is caught before
  // it becomes a failed wrap with a less obvious message.
  const arnLooksWrong = cmkArn.trim().length > 0 && !/^arn:aws[a-z-]*:kms:/.test(cmkArn.trim())
  const busy = attach.isPending || rotate.isPending
  const canAttach = cmkArn.trim().length > 0 && awsRegion.trim().length > 0 && !arnLooksWrong && !busy
  // Rotating to the key already configured is valid: a fresh data key
  // under the same CMK. So an empty ARN is allowed here, unlike attach.
  const canRotate = !arnLooksWrong && !busy

  const { confirm, dialog: confirmDialog } = useConfirm()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Customer-managed keys</CardTitle>
        <CardDescription>
          Secrets are envelope-encrypted under a data key. Attach a KMS key in your own account to wrap that data key, and
          revoking it in AWS makes the stored secrets unreadable to us.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data && (
          <div className="rounded-lg border border-border bg-card p-3 text-sm" data-testid="kms-status">
            {data.provisioned ? (
              <>
                <span className="font-medium text-foreground">
                  {data.enabled ? 'Active' : 'Attached but switched off'}
                </span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{data.cmkArn}</span>
              </>
            ) : (
              <span className="text-muted-foreground">No key attached. Secrets are wrapped under the platform key.</span>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <div>
            <Label htmlFor="kms-arn">CMK ARN</Label>
            <Input
              id="kms-arn"
              className="mt-1 font-mono text-xs"
              placeholder="arn:aws:kms:eu-central-1:111122223333:key/..."
              value={cmkArn}
              onChange={(e) => setCmkArn(e.target.value)}
            />
            {arnLooksWrong && (
              <p data-testid="kms-arn-invalid" className="mt-1 text-xs text-red-600 dark:text-red-400">
                That does not look like a KMS key ARN. It starts with arn:aws:kms:.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="kms-region">Region</Label>
            <Input id="kms-region" className="mt-1" placeholder="eu-central-1" value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          The key never leaves your account. almyty stores the ARN and a data key wrapped under it, never the key itself.
        </p>

        {(attach.isError || rotate.isError) && (
          <p data-testid="kms-error" className="text-xs text-red-600 dark:text-red-400">
            {attach.isError
              ? getApiErrorMessage(attach.error, 'Could not attach that key')
              : getApiErrorMessage(rotate.error, 'Could not rotate the key')}
          </p>
        )}

        {/* Attach and rotate are different operations and the button says
            which one it is. It used to read "Replace key" once a key was
            attached while still calling the attach endpoint — which minted
            a second data key over the first and made every secret sealed
            under the old one unreadable. "Replace" was the wrong word for
            what it did and for what anybody wanted. */}
        {data?.provisioned ? (
          <div className="space-y-2">
            <Button
              data-testid="rotate-cmk"
              disabled={!canRotate}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Rotate the encryption key?',
                  description: cmkArn.trim() && cmkArn.trim() !== data?.cmkArn
                    ? `New secrets will be sealed under ${cmkArn.trim()}. Secrets stored before the rotation stay readable.`
                    : 'A fresh data key is generated under the current key. Secrets stored before the rotation stay readable.',
                  confirmLabel: 'Rotate key',
                })
                if (ok) rotate.mutate()
              }}
            >
              {rotate.isPending ? 'Rotating...' : 'Rotate key'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Generates a fresh data key. Give an ARN above to move to a different key, or leave it
              blank to rotate under the one you have. Secrets stored before the rotation stay
              readable — almyty keeps the wrapped key they were sealed with.
            </p>
          </div>
        ) : (
          <Button data-testid="attach-cmk" disabled={!canAttach} onClick={() => attach.mutate()}>
            {attach.isPending ? 'Attaching...' : 'Attach key'}
          </Button>
        )}

        {data?.provisioned && (
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card p-3">
            <div>
              <Label htmlFor="kms-enabled" className="text-sm font-medium">
                Use this key
              </Label>
              {/* Said plainly: switching off changes what NEW writes use.
                  Someone expecting this to re-encrypt history would
                  otherwise think their data moved when it did not. */}
              <p className="mt-1 text-xs text-muted-foreground">
                Turning this off wraps new secrets under the platform key again. It does not re-encrypt what is already
                stored, and it does not delete anything.
              </p>
            </div>
            <Switch
              id="kms-enabled"
              checked={data.enabled}
              disabled={setEnabled.isPending}
              onCheckedChange={(v) => setEnabled.mutate(Boolean(v))}
            />
          </div>
        )}

        {setEnabled.isError && (
          // A refused toggle left the switch snapping back with no reason
          // given, on the one setting that decides where secrets are
          // wrapped.
          <p data-testid="kms-enabled-error" className="text-xs text-red-600 dark:text-red-400">
            {getApiErrorMessage(setEnabled.error, 'The setting was not changed.')}
          </p>
        )}
      </CardContent>
      {confirmDialog}
    </Card>
  )
}
