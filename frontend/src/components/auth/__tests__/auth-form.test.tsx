import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { AuthField, AuthHeading, PasswordInput } from '../auth-form'
import { Input } from '@/components/ui/input'
import { AuthLayout } from '@/components/layout/auth-layout'

describe('auth form pieces', () => {
  it('names the show/hide control and keeps "Password" the only field with that label', async () => {
    const user = userEvent.setup()
    render(
      <AuthField id="password" label="Password">
        <PasswordInput id="password" />
      </AuthField>,
    )
    const field = screen.getByLabelText('Password')
    expect(field).toHaveAttribute('type', 'password')
    // One match for a loose /password/i query: the toggle is named for what it does.
    expect(screen.getAllByLabelText(/password/i)).toHaveLength(1)

    const toggle = screen.getByRole('button', { name: 'Show what you typed' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    expect(field).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide what you typed' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('ties the hint and the error to the field and marks it invalid', () => {
    render(
      <AuthField id="email" label="Email address" hint="The address you signed up with." error="Enter your email address">
        <Input id="email" />
      </AuthField>,
    )
    const input = screen.getByLabelText('Email address')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('The address you signed up with. Enter your email address')
  })

  it('leaves a valid field unmarked', () => {
    render(
      <AuthField id="email" label="Email address">
        <Input id="email" />
      </AuthField>,
    )
    expect(screen.getByLabelText('Email address')).not.toHaveAttribute('aria-invalid')
  })

  it('gives the page one level-1 heading with its lead', () => {
    render(<AuthHeading title="Sign in" lead="Welcome back." />)
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByText('Welcome back.')).toBeInTheDocument()
  })
})

describe('AuthLayout', () => {
  it('puts the form in the main landmark with the mark above it and no card around it', () => {
    render(
      <AuthLayout>
        <form aria-label="Sign in form" />
      </AuthLayout>,
    )
    const main = screen.getByRole('main')
    expect(main).toContainElement(screen.getByRole('form', { name: 'Sign in form' }))
    expect(screen.getByRole('link', { name: 'almyty' })).toHaveAttribute('href', '/')
    // The colour panel is decoration: hidden from assistive tech, shown from lg up.
    const field = screen.getByTestId('auth-product-field')
    expect(field).toHaveAttribute('aria-hidden')
    expect(field.className).toContain('bg-product-field')
    expect(field.className).toContain('hidden')
    expect(field.className).toContain('lg:flex')
  })
})
