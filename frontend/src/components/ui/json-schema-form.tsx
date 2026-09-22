/* Renders a form from a JSON schema object and validates what the user typed.
 *
 * Built for adapter config (GET /model-adapters -> configSchema) but generic:
 * string / integer / number / boolean, enum, required, default, title and
 * description. A property with "x-secret": true renders as a password field;
 * in edit mode a blank secret means "keep the existing value" and is left out
 * of the submitted object rather than overwriting it with an empty string.
 *
 * Controlled: the parent owns `value`, this component reports every change.
 * `validateSchemaValues` is the single source of truth for what gets sent.
 */
import { useId, useState, type ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { JsonSchemaObject, JsonSchemaProperty } from '@/types/deployments'

export type SchemaFormValues = Record<string, unknown>

export interface SchemaValidationResult {
  ok: boolean
  /** Field key -> message. Empty when ok. */
  errors: Record<string, string>
  /** Coerced values with blanks removed; what to send to the API. */
  value: SchemaFormValues
}

/** Initial form values: the schema defaults, with `existing` layered on top. */
export function schemaDefaults(schema: JsonSchemaObject | null | undefined, existing?: SchemaFormValues): SchemaFormValues {
  const out: SchemaFormValues = {}
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    if (existing && existing[key] !== undefined) {
      // Masked secrets come back as asterisks; never round-trip them.
      if (prop['x-secret'] && typeof existing[key] === 'string' && /^\*+$/.test(existing[key] as string)) continue
      out[key] = existing[key]
    } else if (prop.default !== undefined) {
      out[key] = prop.default
    } else if (prop.type === 'boolean') {
      out[key] = false
    }
  }
  return out
}

export function isSecretProperty(prop: JsonSchemaProperty): boolean {
  return prop['x-secret'] === true
}

/** The x-secret property names of a schema. */
export function secretPropertyKeys(schema: JsonSchemaObject | null | undefined): string[] {
  return Object.entries(schema?.properties ?? {})
    .filter(([, prop]) => isSecretProperty(prop))
    .map(([key]) => key)
}

/**
 * The schema with its secrets no longer required: what a form validates
 * against once a connection supplies them. Mirrors the backend's
 * schemaWithoutSecretRequirements.
 */
export function schemaWithoutSecretRequirements(schema: JsonSchemaObject | null | undefined): JsonSchemaObject | null | undefined {
  if (!schema) return schema
  const secrets = new Set(secretPropertyKeys(schema))
  return { ...schema, required: (schema.required ?? []).filter((key) => !secrets.has(key)) }
}

/** The values without their x-secret entries. */
export function stripSecretValues(schema: JsonSchemaObject | null | undefined, values: SchemaFormValues): SchemaFormValues {
  const secrets = new Set(secretPropertyKeys(schema))
  const out: SchemaFormValues = {}
  for (const [key, v] of Object.entries(values)) if (!secrets.has(key)) out[key] = v
  return out
}
/**
 * Validate and coerce. Numbers arrive as strings from inputs; blanks are
 * dropped; required fields must be present (a secret is exempt in edit mode,
 * where blank means keep the stored value).
 */
export function validateSchemaValues(
  schema: JsonSchemaObject | null | undefined,
  values: SchemaFormValues,
  options: { mode?: 'create' | 'edit' } = {},
): SchemaValidationResult {
  const mode = options.mode ?? 'create'
  const errors: Record<string, string> = {}
  const value: SchemaFormValues = {}
  const required = new Set(schema?.required ?? [])

  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    const raw = values[key]
    const label = prop.title ?? key
    const blank = raw === undefined || raw === null || raw === ''

    if (blank) {
      if (required.has(key) && !(mode === 'edit' && isSecretProperty(prop))) {
        errors[key] = `${label} is required`
      }
      continue
    }

    switch (prop.type) {
      case 'integer':
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
        if (!Number.isFinite(n)) {
          errors[key] = `${label} must be a number`
          break
        }
        if (prop.type === 'integer' && !Number.isInteger(n)) {
          errors[key] = `${label} must be a whole number`
          break
        }
        if (prop.minimum !== undefined && n < prop.minimum) {
          errors[key] = `${label} must be at least ${prop.minimum}`
          break
        }
        if (prop.maximum !== undefined && n > prop.maximum) {
          errors[key] = `${label} must be at most ${prop.maximum}`
          break
        }
        if (prop.enum && !prop.enum.map(Number).includes(n)) {
          errors[key] = `${label} must be one of ${prop.enum.join(', ')}`
          break
        }
        value[key] = n
        break
      }
      case 'boolean': {
        value[key] = raw === true || raw === 'true'
        break
      }
      default: {
        const s = typeof raw === 'string' ? raw : String(raw)
        if (prop.enum && !prop.enum.map(String).includes(s)) {
          errors[key] = `${label} must be one of ${prop.enum.join(', ')}`
          break
        }
        value[key] = s
      }
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, value }
}

export interface JsonSchemaFormProps {
  schema: JsonSchemaObject | null | undefined
  value: SchemaFormValues
  onChange: (next: SchemaFormValues) => void
  errors?: Record<string, string>
  /** In edit mode a blank secret keeps the stored value. */
  mode?: 'create' | 'edit'
  disabled?: boolean
  /** Leave the x-secret fields out: a connection supplies them. */
  hideSecrets?: boolean
  className?: string
}

export function JsonSchemaForm({ schema, value, onChange, errors = {}, mode = 'create', disabled, hideSecrets, className }: JsonSchemaFormProps) {
  const prefix = useId()
  const entries = Object.entries(schema?.properties ?? {}).filter(([, prop]) => !(hideSecrets && isSecretProperty(prop)))
  const required = new Set(schema?.required ?? [])

  if (entries.length === 0) {
    return <p className={cn('text-sm text-muted-foreground', className)}>{hideSecrets && Object.keys(schema?.properties ?? {}).length > 0 ? 'The connection covers every setting of this provider.' : 'This provider needs no configuration.'}</p>
  }

  const set = (key: string, next: unknown) => onChange({ ...value, [key]: next })

  return (
    <div className={cn('space-y-4', className)}>
      {entries.map(([key, prop]) => (
        <SchemaField
          key={key}
          id={`${prefix}-${key}`}
          name={key}
          prop={prop}
          required={required.has(key)}
          value={value[key]}
          error={errors[key]}
          mode={mode}
          disabled={disabled}
          onChange={(next) => set(key, next)}
        />
      ))}
    </div>
  )
}

interface SchemaFieldProps {
  id: string
  name: string
  prop: JsonSchemaProperty
  required: boolean
  value: unknown
  error?: string
  mode: 'create' | 'edit'
  disabled?: boolean
  onChange: (next: unknown) => void
}

function SchemaField({ id, name, prop, required, value, error, mode, disabled, onChange }: SchemaFieldProps) {
  const [reveal, setReveal] = useState(false)
  const label = prop.title ?? name
  const secret = isSecretProperty(prop)
  const describedBy = [prop.description ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined

  let control: ReactNode
  if (prop.type === 'boolean') {
    control = (
      <div className="flex items-center gap-3">
        <Switch id={id} checked={value === true || value === 'true'} onCheckedChange={(checked) => onChange(checked)} disabled={disabled} aria-describedby={describedBy} />
        <span className="text-sm text-muted-foreground">{value === true || value === 'true' ? 'On' : 'Off'}</span>
      </div>
    )
  } else if (prop.enum && prop.enum.length > 0) {
    control = (
      <select
        id={id}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={describedBy}
        className="flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="">{required ? 'Select...' : 'Not set'}</option>
        {prop.enum.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </select>
    )
  } else if (secret) {
    control = (
      <div className="flex gap-2">
        <Input
          id={id}
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={mode === 'edit' ? 'Leave blank to keep the existing value' : undefined}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={describedBy}
        />
        <Button type="button" variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => setReveal((r) => !r)} aria-label={reveal ? `Hide ${label}` : `Show ${label}`} disabled={disabled}>
          {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </div>
    )
  } else {
    const numeric = prop.type === 'integer' || prop.type === 'number'
    control = (
      <Input
        id={id}
        type={numeric ? 'number' : 'text'}
        inputMode={numeric ? 'decimal' : undefined}
        step={prop.type === 'integer' ? 1 : prop.type === 'number' ? 'any' : undefined}
        min={prop.minimum}
        max={prop.maximum}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={prop.default !== undefined ? String(prop.default) : undefined}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={describedBy}
      />
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <Label htmlFor={id}>{label}</Label>
        {required && <span className="text-destructive" aria-hidden="true">*</span>}
        {secret && <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">secret</span>}
      </div>
      {control}
      {prop.description && (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {prop.description}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
