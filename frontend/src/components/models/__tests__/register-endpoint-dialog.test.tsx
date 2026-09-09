import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { RegisterEndpointDialog } from '../register-endpoint-dialog'

describe('RegisterEndpointDialog', () => {
  it('submits the register-endpoint body with private_cloud as the default tier', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<RegisterEndpointDialog open onOpenChange={() => {}} onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText('Name'), 'Office vLLM')
    await userEvent.type(screen.getByLabelText('Base URL'), 'http://10.0.0.5:8000/v1')
    await userEvent.type(screen.getByLabelText('Model id'), 'qwen3-14b')
    await userEvent.type(screen.getByLabelText(/Region/), 'eu-central')
    await userEvent.type(screen.getByLabelText(/Context length/), '32768')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tools' }))

    await userEvent.click(screen.getByRole('button', { name: 'Register endpoint' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Office vLLM',
      url: 'http://10.0.0.5:8000/v1',
      vendorModelId: 'qwen3-14b',
      privacyTier: 'private_cloud',
      region: 'eu-central',
      contextLength: 32768,
      capabilities: { tools: true },
    })
    // No key typed: the field is left out rather than sent empty.
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('apiKey')
  })

  it('sends the API key when one is typed', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<RegisterEndpointDialog open onOpenChange={() => {}} onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText('Name'), 'Keyed')
    await userEvent.type(screen.getByLabelText('Base URL'), 'https://models.example.com/v1')
    await userEvent.type(screen.getByLabelText(/API key/), 'sk-test')
    await userEvent.type(screen.getByLabelText('Model id'), 'llama-3.3-70b')
    await userEvent.click(screen.getByRole('button', { name: 'Register endpoint' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ apiKey: 'sk-test', privacyTier: 'private_cloud' })
  })

  it('refuses a URL without a protocol and a missing model id', async () => {
    const onSubmit = vi.fn()
    render(<RegisterEndpointDialog open onOpenChange={() => {}} onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText('Name'), 'Bad')
    await userEvent.type(screen.getByLabelText('Base URL'), '10.0.0.5:8000')
    await userEvent.click(screen.getByRole('button', { name: 'Register endpoint' }))

    expect(await screen.findByText('Enter the base URL including the protocol')).toBeInTheDocument()
    expect(screen.getByText('Model id is required')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('RegisterEndpointDialog base URL field', () => {
  it('suggests a hostname, not a private address, and explains the private-host switch', () => {
    render(<RegisterEndpointDialog open onOpenChange={() => {}} onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('Base URL')).toHaveAttribute('placeholder', 'https://llm.example.internal/v1')
    expect(screen.getByText(/LLM_ALLOW_PRIVATE_URLS=true/)).toBeInTheDocument()
  })
})
