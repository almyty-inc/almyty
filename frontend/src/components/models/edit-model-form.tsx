import React, { useEffect } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { formatModelPrice, PRICING_SOURCE_LABELS } from '@/lib/models-api'
import type { ModelCard, UpdateModelBody } from '@/types/models'
import { editModelSchema, compactCapabilities, pricingFromForm, type EditModelFormData, type EditModelFormOutput } from './schema'
import { CapabilitiesField, PrivacyTierField } from './model-form-fields'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

interface EditModelFormProps {
  card: ModelCard
  onCancel?: () => void
  onSubmit: (id: string, body: UpdateModelBody) => Promise<unknown> | void
  submitting?: boolean
}

function toForm(card: ModelCard): EditModelFormData {
  return {
    name: card.name,
    privacyTier: card.privacyTier,
    region: card.region || '',
    contextLength: card.contextLength ?? '',
    capabilities: {
      tools: !!card.capabilities?.tools,
      vision: !!card.capabilities?.vision,
      reasoning: !!card.capabilities?.reasoning,
      embedding: !!card.capabilities?.embedding,
      structuredOutput: !!card.capabilities?.structuredOutput,
    },
    overridePrice: !!card.pricingOverride,
    inPerMTok: card.pricingOverride?.inPerMTok ?? '',
    outPerMTok: card.pricingOverride?.outPerMTok ?? '',
  }
}

/** The operator-owned settings of a model, edited inline on its page. Vendor id and provider stay fixed. */
export function EditModelForm({ card, onCancel, onSubmit, submitting }: EditModelFormProps) {
  const form = useForm<EditModelFormData, unknown, EditModelFormOutput>({
    resolver: zodResolver(editModelSchema),
    defaultValues: card ? toForm(card) : undefined,
  })

  // Re-seed when the saved model changes (a save, a validation run), not
  // on every refetch of the same row, which would wipe what is being typed.
  useEffect(() => {
    form.reset(toForm(card))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, card.updatedAt])

  // Unsaved edits ask before a navigation throws them away. A save lands as
  // a new updatedAt, which re-seeds the form and makes it clean again.
  const guard = useLeaveGuard(form.formState.isDirty && !submitting)

  const overridePrice = form.watch('overridePrice')
  const errors = form.formState.errors

  const submit = form.handleSubmit(async (data) => {
    if (!card) return
    const body: UpdateModelBody = {
      name: data.name,
      privacyTier: data.privacyTier as UpdateModelBody['privacyTier'],
      region: data.region ? data.region : null,
      contextLength: data.contextLength ?? null,
      capabilities: compactCapabilities(data.capabilities) ?? {},
      pricingOverride: pricingFromForm(data),
    }
    await onSubmit(card.id, body)
  })

  const feedPrice = card?.pricing
  const feedSource = card ? PRICING_SOURCE_LABELS[card.pricingSource] || card.pricingSource : ''

  return (
          <form onSubmit={submit} className="space-y-4" noValidate aria-label="Model settings">
            <div>
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" className="mt-1" {...form.register('name')} />
              {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
            </div>
            <PrivacyTierField control={form.control} name="privacyTier" id="edit-tier" />
            <div>
              <Label htmlFor="edit-region">Region</Label>
              <Input id="edit-region" className="mt-1" placeholder="Any region" {...form.register('region')} />
            </div>
            <div>
              <Label htmlFor="edit-context">Context length</Label>
              <Input id="edit-context" type="number" min={1} className="mt-1" placeholder="Unknown" {...form.register('contextLength')} />
              {errors.contextLength && <p className="text-xs text-destructive mt-1">{String(errors.contextLength.message)}</p>}
            </div>
            <CapabilitiesField control={form.control} />

            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="edit-override-price">Price override</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Feed: {formatModelPrice(feedPrice)} <span className="text-muted-foreground/70">({feedSource})</span>
                  </p>
                </div>
                <Controller
                  control={form.control}
                  name="overridePrice"
                  render={({ field }) => (
                    <Switch id="edit-override-price" checked={!!field.value} onCheckedChange={field.onChange} aria-label="Override price" />
                  )}
                />
              </div>
              {overridePrice ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="edit-price-in" className="text-xs">Input, $ per MTok</Label>
                    <Input id="edit-price-in" type="number" step="any" min={0} className="mt-1" {...form.register('inPerMTok')} />
                    {errors.inPerMTok && <p className="text-xs text-destructive mt-1">{String(errors.inPerMTok.message)}</p>}
                  </div>
                  <div>
                    <Label htmlFor="edit-price-out" className="text-xs">Output, $ per MTok</Label>
                    <Input id="edit-price-out" type="number" step="any" min={0} className="mt-1" {...form.register('outPerMTok')} />
                    {errors.outPerMTok && <p className="text-xs text-destructive mt-1">{String(errors.outPerMTok.message)}</p>}
                  </div>
                  <div className="col-span-2">
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => {
                        form.setValue('overridePrice', false)
                        form.setValue('inPerMTok', '')
                        form.setValue('outPerMTok', '')
                      }}
                    >
                      Use feed price
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">The daily price feed sets the price. Turn the override on to type your own.</p>
              )}
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
              <Button type="submit" disabled={submitting || !form.formState.isDirty}>
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save changes
              </Button>
            </div>
            {guard.element}
          </form>
  )
}
