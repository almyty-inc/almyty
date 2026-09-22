import React from 'react'
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form'

import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  MODEL_CAPABILITY_KEYS,
  MODEL_CAPABILITY_LABELS,
  MODEL_PRIVACY_TIERS,
  MODEL_PRIVACY_TIER_LABELS,
} from '@/types/models'

/** Privacy select bound to a react-hook-form field named `privacyTier`. */
export function PrivacyTierField<T extends FieldValues>({ control, name, id = 'privacyTier' }: { control: Control<T>; name: Path<T>; id?: string }) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <div>
          <Label htmlFor={id}>Privacy</Label>
          <Select value={field.value || ''} onValueChange={field.onChange}>
            <SelectTrigger id={id} className="mt-1" aria-label="Privacy">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {MODEL_PRIVACY_TIERS.map((tier) => (
                <SelectItem key={tier} value={tier}>{MODEL_PRIVACY_TIER_LABELS[tier]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">Where the model runs. A routing policy can require this or stricter: local, then private cloud, then public.</p>
        </div>
      )}
    />
  )
}

/** Five capability checkboxes bound to `capabilities.<key>` fields. */
export function CapabilitiesField<T extends FieldValues>({ control, prefix = 'capabilities' }: { control: Control<T>; prefix?: string }) {
  return (
    <div>
      <Label>Capabilities</Label>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {MODEL_CAPABILITY_KEYS.map((key) => (
          <Controller
            key={key}
            control={control}
            name={`${prefix}.${key}` as Path<T>}
            render={({ field }) => (
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={!!field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                  aria-label={MODEL_CAPABILITY_LABELS[key]}
                />
                {MODEL_CAPABILITY_LABELS[key]}
              </label>
            )}
          />
        ))}
      </div>
    </div>
  )
}
