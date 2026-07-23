import React from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/store/auth'
import { useNotifications } from '@/store/app'
import { authApi } from '@/lib/api'

const loginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Invalid email address'),
  password: z.string().min(1, 'Password is required').min(6, 'Password must be at least 6 characters'),
})

type LoginFormData = z.infer<typeof loginSchema>

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { login, isLoading } = useAuthStore()
  const { success, error } = useNotifications()
  const [showPassword, setShowPassword] = React.useState(false)
  const [loginError, setLoginError] = React.useState<string | null>(null)
  // When login is refused with EMAIL_NOT_VERIFIED, we swap the form for a
  // "verify your email" prompt with a resend action. Holds the address the
  // login attempt used so we can resend without re-asking.
  const [unverifiedEmail, setUnverifiedEmail] = React.useState<string | null>(null)
  const [resending, setResending] = React.useState(false)
  const [resent, setResent] = React.useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<LoginFormData>({
    mode: 'onTouched',
    resolver: zodResolver(loginSchema),
  })

  // Honour ?returnTo=… so flows like the CLI browser login (which sends
  // the user through /auth/login?returnTo=/cli-login?…) come back to
  // their original destination after a successful sign-in. Only allow
  // SAME-ORIGIN paths to prevent open-redirect.
  const returnTo = (() => {
    const raw = new URLSearchParams(location.search).get('returnTo')
    if (!raw) return null
    // Allow relative paths (same-origin navigation)
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw
    // Allow absolute URLs to the API domain (OAuth authorize callbacks)
    try {
      const url = new URL(raw)
      const apiBase = import.meta.env.VITE_API_BASE_URL || ''
      if (apiBase && url.origin === new URL(apiBase).origin) return raw
    } catch {}
    return null
  })()

  const onSubmit = async (data: LoginFormData) => {
    setLoginError(null)
    setResent(false)
    try {
      await login(data.email, data.password)
      success('Login successful', 'Welcome back!')
      if (returnTo?.startsWith('http')) {
        window.location.href = returnTo
      } else {
        navigate(returnTo ?? '/dashboard')
      }
    } catch (err: any) {
      // The backend refuses unverified accounts with a distinct
      // EMAIL_NOT_VERIFIED code (403). Surface the verify-your-email prompt
      // instead of a dead "invalid credentials" end.
      const envelope = err.response?.data
      const code = envelope?.error?.code ?? envelope?.code
      if (code === 'EMAIL_NOT_VERIFIED') {
        setUnverifiedEmail(envelope?.error?.email ?? data.email)
        return
      }
      const errorMessage = envelope?.error?.message || envelope?.message || 'Invalid credentials. Please check your email and password.'
      setLoginError(errorMessage)
      error('Login failed', errorMessage)
    }
  }

  const handleResendVerification = async () => {
    if (!unverifiedEmail) return
    setResending(true)
    try {
      await authApi.resendVerificationByEmail(unverifiedEmail)
      // Neutral confirmation — the endpoint is enumeration-safe, so we don't
      // assert anything about whether the account exists.
      setResent(true)
    } catch {
      // Even on transport error, keep the neutral message; nothing here is
      // account-state-revealing.
      setResent(true)
    } finally {
      setResending(false)
    }
  }

  if (unverifiedEmail) {
    return (
      <div>
        <h1 className="text-2xl font-heading font-bold mb-2">Please verify your email</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Your account isn&apos;t verified yet. We sent a verification link to{' '}
          <span className="font-medium text-foreground">{unverifiedEmail}</span>. Click the
          link in that email to activate your account, then sign in.
        </p>

        {resent ? (
          <div className="mb-4 p-3 bg-muted border border-border rounded-md">
            <p className="text-sm text-muted-foreground">
              If an account exists for that address, we&apos;ve re-sent the verification link.
              Check your inbox (and spam folder).
            </p>
          </div>
        ) : (
          <Button
            type="button"
            className="w-full"
            onClick={handleResendVerification}
            disabled={resending}
            aria-disabled={resending}
          >
            {resending ? 'Sending…' : 'Resend verification email'}
          </Button>
        )}

        <div className="mt-6 text-center">
          <button
            type="button"
            className="text-sm font-medium text-primary hover:text-primary/80"
            onClick={() => {
              setUnverifiedEmail(null)
              setResent(false)
            }}
          >
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-heading font-bold mb-6">Sign in</h1>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div>
          <Label htmlFor="email">Email address</Label>
          <div className="mt-1">
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="Enter your email"
              {...register('email')}
              className={errors.email ? 'border-red-300' : ''}
            />
            {errors.email && (
              <p className="mt-2 text-sm text-red-600">{errors.email.message}</p>
            )}
          </div>
        </div>

        <div>
          <Label htmlFor="password">Password</Label>
          <div className="mt-1 relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Enter your password"
              {...register('password')}
              className={errors.password ? 'border-red-300' : ''}
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 pr-3 flex items-center"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Eye className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {errors.password && (
              <p className="mt-2 text-sm text-red-600">{errors.password.message}</p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <input
              id="remember-me"
              name="remember-me"
              type="checkbox"
              className="h-4 w-4 text-primary focus:ring-primary border-border rounded"
            />
            <Label htmlFor="remember-me" className="ml-2 block text-sm text-foreground">
              Remember me
            </Label>
          </div>
          <Link
            to="/auth/forgot-password"
            className="text-sm font-medium text-primary hover:text-primary/80"
          >
            Forgot password?
          </Link>
        </div>

        <div>
          {loginError && (
            <div
              role="alert"
              aria-live="polite"
              className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-md"
            >
              <p className="text-sm text-destructive">{loginError}</p>
            </div>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={isLoading}
            aria-disabled={isLoading}
            title={isLoading ? 'Signing you in…' : undefined}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                Signing in...
              </>
            ) : (
              'Sign in'
            )}
          </Button>
        </div>
      </form>

      <div className="mt-6 text-center">
        <p className="text-sm text-muted-foreground">
          Don't have an account?{' '}
          <Link
            to="/auth/register"
            className="font-medium text-primary hover:text-primary/80"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  )
}