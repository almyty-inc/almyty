import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import { JsonSchemaForm, schemaDefaults, validateSchemaValues, type SchemaFormValues } from '../json-schema-form'
import type { JsonSchemaObject } from '@/types/deployments'

const schema: JsonSchemaObject = {
  type: 'object',
  properties: {
    baseUrl: { type: 'string', title: 'Server URL', description: 'Where the server listens', default: 'http://localhost:11434' },
    token: { type: 'string', title: 'Bearer token', 'x-secret': true },
    hourlyRateCents: { type: 'integer', title: 'Price per hour (cents)', minimum: 0 },
    tier: { type: 'string', title: 'Tier', enum: ['basic', 'pro'] },
    verbose: { type: 'boolean', title: 'Verbose logs' },
    ratio: { type: 'number', title: 'Ratio' },
  },
  required: ['baseUrl', 'token'],
}

describe('schemaDefaults', () => {
  it('seeds defaults, false for booleans, and nothing for the rest', () => {
    expect(schemaDefaults(schema)).toEqual({ baseUrl: 'http://localhost:11434', verbose: false })
  })

  it('layers existing values on top but drops masked secrets', () => {
    const out = schemaDefaults(schema, { baseUrl: 'http://gpu:11434', token: '********', tier: 'pro' })
    expect(out).toEqual({ baseUrl: 'http://gpu:11434', tier: 'pro', verbose: false })
  })

  it('copes with a schema that has no properties', () => {
    expect(schemaDefaults({ type: 'object' })).toEqual({})
    expect(schemaDefaults(null)).toEqual({})
  })
})

describe('validateSchemaValues', () => {
  it('coerces numbers and booleans and drops blanks', () => {
    const r = validateSchemaValues(schema, { baseUrl: 'http://x', token: 's3cret', hourlyRateCents: '250', verbose: true, ratio: '0.5', tier: '' })
    expect(r.ok).toBe(true)
    expect(r.value).toEqual({ baseUrl: 'http://x', token: 's3cret', hourlyRateCents: 250, verbose: true, ratio: 0.5 })
  })

  it('reports required fields by their title', () => {
    const r = validateSchemaValues(schema, { baseUrl: '' })
    expect(r.ok).toBe(false)
    expect(r.errors.baseUrl).toBe('Server URL is required')
    expect(r.errors.token).toBe('Bearer token is required')
  })

  it('lets a blank required secret through in edit mode so the stored one is kept', () => {
    const r = validateSchemaValues(schema, { baseUrl: 'http://x', token: '' }, { mode: 'edit' })
    expect(r.ok).toBe(true)
    expect('token' in r.value).toBe(false)
  })

  it('rejects non-integers, values below minimum and unknown enum members', () => {
    const r = validateSchemaValues(schema, { baseUrl: 'http://x', token: 't', hourlyRateCents: '1.5', tier: 'gold' })
    expect(r.ok).toBe(false)
    expect(r.errors.hourlyRateCents).toMatch(/whole number/)
    expect(r.errors.tier).toMatch(/one of basic, pro/)
    expect(validateSchemaValues(schema, { baseUrl: 'http://x', token: 't', hourlyRateCents: '-1' }).errors.hourlyRateCents).toMatch(/at least 0/)
    expect(validateSchemaValues(schema, { baseUrl: 'http://x', token: 't', ratio: 'abc' }).errors.ratio).toMatch(/must be a number/)
  })
})

function Harness({ initial = {}, mode, onChange }: { initial?: SchemaFormValues; mode?: 'create' | 'edit'; onChange?: (v: SchemaFormValues) => void }) {
  const [value, setValue] = useState<SchemaFormValues>(initial)
  return (
    <JsonSchemaForm
      schema={schema}
      value={value}
      mode={mode}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      errors={{ baseUrl: 'Server URL is required' }}
    />
  )
}

describe('JsonSchemaForm', () => {
  it('renders title as label, description as help, and marks required and secret fields', () => {
    render(<Harness />)
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument()
    expect(screen.getByText('Where the server listens')).toBeInTheDocument()
    expect(screen.getByLabelText('Bearer token')).toHaveAttribute('type', 'password')
    expect(screen.getByText('secret')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Server URL is required')
  })

  it('renders enums as a select and booleans as a switch', () => {
    render(<Harness />)
    const tier = screen.getByLabelText('Tier') as HTMLSelectElement
    expect(tier.tagName).toBe('SELECT')
    expect(Array.from(tier.options).map((o) => o.value)).toEqual(['', 'basic', 'pro'])
    expect(screen.getByRole('switch', { name: /Verbose logs/ })).toBeInTheDocument()
  })

  it('reports every change to the parent', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'hf_abc' } })
    expect(onChange).toHaveBeenLastCalledWith({ token: 'hf_abc' })
    fireEvent.change(screen.getByLabelText('Tier'), { target: { value: 'pro' } })
    expect(onChange).toHaveBeenLastCalledWith({ token: 'hf_abc', tier: 'pro' })
    fireEvent.click(screen.getByRole('switch', { name: /Verbose logs/ }))
    expect(onChange).toHaveBeenLastCalledWith({ token: 'hf_abc', tier: 'pro', verbose: true })
  })

  it('says a blank secret keeps the existing value when editing', () => {
    render(<Harness mode="edit" />)
    expect(screen.getByLabelText('Bearer token')).toHaveAttribute('placeholder', 'Leave blank to keep the existing value')
  })

  it('reveals a secret on request', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Show Bearer token' }))
    expect(screen.getByLabelText('Bearer token')).toHaveAttribute('type', 'text')
  })

  it('says so when the schema has no properties', () => {
    render(<JsonSchemaForm schema={{ type: 'object' }} value={{}} onChange={() => {}} />)
    expect(screen.getByText(/needs no configuration/)).toBeInTheDocument()
  })
})
