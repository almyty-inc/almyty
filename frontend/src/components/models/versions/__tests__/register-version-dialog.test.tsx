import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { parseRegistryUri } from '../../../../lib/deployments-api'
import { RegisterVersionDialog, registerVersionSchema, toRegisterBody } from '../register-version-dialog'

describe('parseRegistryUri', () => {
  it('accepts the three shapes and splits them', () => {
    expect(parseRegistryUri('s3://registry/qwen3-14b@e3b0c442')).toEqual({ ok: true, value: { scheme: 's3', location: 'registry', prefix: 'qwen3-14b', pin: 'e3b0c442' } })
    expect(parseRegistryUri('s3://bucket@etag')).toEqual({ ok: true, value: { scheme: 's3', location: 'bucket', prefix: '', pin: 'etag' } })
    expect(parseRegistryUri('hf://Qwen/Qwen3-14B@abc123')).toEqual({ ok: true, value: { scheme: 'hf', location: 'Qwen/Qwen3-14B', prefix: '', pin: 'abc123' } })
    expect(parseRegistryUri(' file:///models/qwen@sha256:ff ')).toEqual({ ok: true, value: { scheme: 'file', location: '/models/qwen', prefix: '', pin: 'sha256:ff' } })
  })

  it('refuses a URI without a pin', () => {
    const r = parseRegistryUri('s3://registry/qwen3-14b')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/@pin is required/)
  })

  it('refuses unknown schemes, traversal, relative file paths and bad hub ids', () => {
    expect(parseRegistryUri('gs://bucket/x@1').ok).toBe(false)
    expect(parseRegistryUri('s3://bucket/../x@1').ok).toBe(false)
    expect(parseRegistryUri('file://models/x@1').ok).toBe(false)
    expect(parseRegistryUri('hf://onlyorg@1').ok).toBe(false)
    expect(parseRegistryUri('').ok).toBe(false)
  })
})

describe('registerVersionSchema + toRegisterBody', () => {
  it('validates the URI grammar through zod', () => {
    const bad = registerVersionSchema.safeParse({ name: 'n', base: 'b', registryUri: 'hf://org/repo' })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error.issues.map((i) => i.path.join('.'))).toContain('registryUri')
    expect(registerVersionSchema.safeParse({ name: 'n', base: 'b', registryUri: 'hf://org/repo@main' }).success).toBe(true)
  })

  it('splits quantizations and drops empty lineage', () => {
    expect(toRegisterBody({ name: ' v1 ', base: 'qwen3-14b', registryUri: 's3://b/p@e', quantizations: 'bf16, awq-int4,,bf16', parentVersionId: '', datasetRef: '', trainingJobId: '' })).toEqual({
      name: 'v1',
      base: 'qwen3-14b',
      registryUri: 's3://b/p@e',
      quantizations: ['bf16', 'awq-int4'],
    })
    expect(toRegisterBody({ name: 'v1', base: 'b', registryUri: 's3://b/p@e', parentVersionId: 'v0' }).lineage).toEqual({ parentVersionId: 'v0' })
  })
})

describe('RegisterVersionDialog', () => {
  it('rejects a registry URI without a pin and does not submit', async () => {
    const onSubmit = vi.fn()
    render(<RegisterVersionDialog open onOpenChange={() => {}} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'support-bot-v3' } })
    fireEvent.change(screen.getByLabelText('Base architecture'), { target: { value: 'qwen3-14b' } })
    fireEvent.change(screen.getByLabelText('Registry URI'), { target: { value: 's3://registry/support-bot-v3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    expect(await screen.findByText(/The @pin is required/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('explains a valid URI and submits the body', async () => {
    const onSubmit = vi.fn()
    render(<RegisterVersionDialog open onOpenChange={() => {}} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'support-bot-v3' } })
    fireEvent.change(screen.getByLabelText('Base architecture'), { target: { value: 'qwen3-14b' } })
    fireEvent.change(screen.getByLabelText('Registry URI'), { target: { value: 'hf://Qwen/Qwen3-14B@abc123' } })
    fireEvent.change(screen.getByLabelText('Quantizations'), { target: { value: 'bf16, awq-int4' } })
    await waitFor(() => expect(screen.getByTestId('registry-uri-parsed')).toHaveTextContent('Hugging Face repo Qwen/Qwen3-14B, pinned at abc123'))
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'support-bot-v3', base: 'qwen3-14b', registryUri: 'hf://Qwen/Qwen3-14B@abc123', quantizations: ['bf16', 'awq-int4'] })
  })

  it('requires a name but lets base come from the manifest', async () => {
    const onSubmit = vi.fn()
    render(<RegisterVersionDialog open onOpenChange={() => {}} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    expect(await screen.findByText('Name is required')).toBeInTheDocument()
    expect(screen.queryByText(/Base architecture is required/)).not.toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'from-registry' } })
    fireEvent.change(screen.getByLabelText('Registry URI'), { target: { value: 's3://registry/from-registry@e3b0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: 'from-registry', registryUri: 's3://registry/from-registry@e3b0' }))
  })
})
