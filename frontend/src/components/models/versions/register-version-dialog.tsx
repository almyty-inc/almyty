import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseRegistryUri } from '@/lib/deployments-api'
import type { RegisterModelVersionBody } from '@/types/deployments'

export const registerVersionSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Keep the name under 120 characters'),
  base: z.string().trim().max(120, 'Keep the base under 120 characters').optional(),
  registryUri: z
    .string()
    .trim()
    .min(1, 'Registry URI is required')
    .superRefine((value, ctx) => {
      const parsed = parseRegistryUri(value)
      if (!parsed.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error })
    }),
  quantizations: z.string().trim().optional(),
  parentVersionId: z.string().trim().optional(),
  datasetRef: z.string().trim().optional(),
  trainingJobId: z.string().trim().optional(),
})

export type RegisterVersionFormValues = z.infer<typeof registerVersionSchema>

/** Form values to the POST body: comma-separated quantizations become a list, empty lineage is dropped. */
export function toRegisterBody(values: RegisterVersionFormValues): RegisterModelVersionBody {
  const body: RegisterModelVersionBody = {
    name: values.name.trim(),
    ...(values.base?.trim() ? { base: values.base.trim() } : {}),
    registryUri: values.registryUri.trim(),
  }
  const quantizations = (values.quantizations ?? '')
    .split(',')
    .map((q) => q.trim())
    .filter(Boolean)
  if (quantizations.length > 0) body.quantizations = Array.from(new Set(quantizations))
  const lineage: RegisterModelVersionBody['lineage'] = {}
  if (values.parentVersionId?.trim()) lineage.parentVersionId = values.parentVersionId.trim()
  if (values.datasetRef?.trim()) lineage.datasetRef = values.datasetRef.trim()
  if (values.trainingJobId?.trim()) lineage.trainingJobId = values.trainingJobId.trim()
  if (Object.keys(lineage).length > 0) body.lineage = lineage
  return body
}

export interface RegisterVersionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (body: RegisterModelVersionBody) => void
  submitting?: boolean
}

const EMPTY: RegisterVersionFormValues = { name: '', base: '', registryUri: '', quantizations: '', parentVersionId: '', datasetRef: '', trainingJobId: '' }

export function RegisterVersionDialog({ open, onOpenChange, onSubmit, submitting }: RegisterVersionDialogProps) {
  const form = useForm<RegisterVersionFormValues>({ resolver: zodResolver(registerVersionSchema), defaultValues: EMPTY, mode: 'onSubmit' })
  const { register, handleSubmit, formState, reset, watch } = form
  const errors = formState.errors
  const uriValue = watch('registryUri')
  const parsedUri = uriValue ? parseRegistryUri(uriValue) : null

  useEffect(() => {
    if (open) reset(EMPTY)
  }, [open, reset])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Register a version</DialogTitle>
          <DialogDescription>Point at weights already in the registry. The URI must pin exact bytes with an @etag or @sha; the manifest next to them fills in size and digest.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => onSubmit(toRegisterBody(values)))} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="version-name">Name</Label>
              <Input id="version-name" placeholder="support-bot-v3" {...register('name')} aria-invalid={!!errors.name} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="version-base">Base architecture</Label>
              <Input id="version-base" placeholder="qwen3-14b" {...register('base')} aria-invalid={!!errors.base} aria-describedby="version-base-help" />
              {errors.base ? <FieldError>{errors.base.message}</FieldError> : <p id="version-base-help" className="text-xs text-muted-foreground">Read from the manifest when there is one; required for hf:// and file:// URIs without it.</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="version-registry-uri">Registry URI</Label>
            <Input id="version-registry-uri" className="font-mono" placeholder="s3://registry/qwen3-14b@e3b0c442" {...register('registryUri')} aria-invalid={!!errors.registryUri} aria-describedby="version-registry-uri-help" />
            {errors.registryUri ? (
              <FieldError>{errors.registryUri.message}</FieldError>
            ) : parsedUri?.ok ? (
              <p className="text-xs text-muted-foreground" data-testid="registry-uri-parsed">
                {parsedUri.value.scheme === 's3' && `S3 bucket ${parsedUri.value.location}${parsedUri.value.prefix ? `, prefix ${parsedUri.value.prefix}` : ''}`}
                {parsedUri.value.scheme === 'hf' && `Hugging Face repo ${parsedUri.value.location}`}
                {parsedUri.value.scheme === 'file' && `Runner-local path ${parsedUri.value.location}`}
                {`, pinned at ${parsedUri.value.pin}`}
              </p>
            ) : (
              <p id="version-registry-uri-help" className="text-xs text-muted-foreground">
                s3://bucket/prefix@etag, hf://org/repo@sha or file:///path@sha
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="version-quantizations">Quantizations</Label>
            <Input id="version-quantizations" placeholder="bf16, awq-int4" {...register('quantizations')} />
            <p className="text-xs text-muted-foreground">Comma separated. Leave blank to read them from the manifest.</p>
          </div>
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">Lineage (optional)</summary>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="version-parent">Parent version id</Label>
                <Input id="version-parent" {...register('parentVersionId')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="version-dataset">Dataset ref</Label>
                <Input id="version-dataset" {...register('datasetRef')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="version-training-job">Training job id</Label>
                <Input id="version-training-job" {...register('trainingJobId')} />
              </div>
            </div>
          </details>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Registering...' : 'Register'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function FieldError({ children }: { children?: string }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  )
}
