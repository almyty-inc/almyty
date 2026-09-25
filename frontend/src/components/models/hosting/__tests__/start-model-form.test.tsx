/**
 * "Start a model" on a cloud account's provider page asks one thing up
 * front: which model. Everything else waits under Advanced.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { render } from '../../../../test/setup'
import { StartModelForm, huggingFaceRef } from '../start-model-form'
import { bedrockAdapter, hfAdapter } from './fixtures'

describe('huggingFaceRef', () => {
  it('turns a repository or a pasted link into an hf:// reference', () => {
    expect(huggingFaceRef('Qwen/Qwen3-0.6B')).toBe('hf://Qwen/Qwen3-0.6B')
    expect(huggingFaceRef(' https://huggingface.co/Qwen/Qwen3-0.6B/ ')).toBe('hf://Qwen/Qwen3-0.6B')
    expect(huggingFaceRef('hf://Qwen/Qwen3-0.6B')).toBe('hf://Qwen/Qwen3-0.6B')
    expect(huggingFaceRef('')).toBe('')
  })
})

describe('StartModelForm', () => {
  it('asks only which model, and sends it as hf:// with the provider account as the credential', () => {
    const onSubmit = vi.fn()
    render(<StartModelForm adapter={hfAdapter} credentialId="conn-hf" onSubmit={onSubmit} />)

    // One question in view; region, size and the cloud's settings are folded away.
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.queryByLabelText('Region')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.change(screen.getByLabelText('Which model?'), { target: { value: 'Qwen/Qwen3-0.6B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const body = onSubmit.mock.calls[0][0]
    expect(body).toMatchObject({ providerType: 'huggingface-endpoints', model: 'hf://Qwen/Qwen3-0.6B', credentialId: 'conn-hf' })
    // The connected account supplies the token; it is never pasted or sent.
    expect(body.providerConfig?.apiToken).toBeUndefined()
  })

  it('says which model is missing instead of sending an empty request', () => {
    const onSubmit = vi.fn()
    render(<StartModelForm adapter={hfAdapter} credentialId="conn-hf" onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Say which model to start')
  })

  it('opens Advanced when the cloud still needs a setting, such as a token with no connected account', () => {
    const onSubmit = vi.fn()
    render(<StartModelForm adapter={hfAdapter} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText('Which model?'), { target: { value: 'Qwen/Qwen3-0.6B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Region')).toBeInTheDocument()
  })

  it('asks where the weights are on a cloud that only reads a bucket', () => {
    const onSubmit = vi.fn()
    render(<StartModelForm adapter={bedrockAdapter} credentialId="conn-aws" onSubmit={onSubmit} />)
    const field = screen.getByLabelText('Which model?')
    expect(field).toHaveAttribute('placeholder', 's3://bucket/path/to/weights')
    fireEvent.change(field, { target: { value: 's3://acme/weights/qwen@sha256:abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    // Bedrock import needs its role, which waits under Advanced.
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/Role ARN/), { target: { value: 'arn:aws:iam::1:role/import' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ providerType: 'aws-bedrock-import', model: 's3://acme/weights/qwen@sha256:abc' })
  })
})
