import React from 'react'
import { Form } from '@/components/ui/form'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { KeyRound, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuthStore } from '@/store/auth'
import { useNotifications } from '@/store/app'
import { authApi } from '@/lib/api'
import { loginReturnTo } from '@/lib/return-to'
import { CheckEmail } from '@/components/auth/check-email'
import { AuthAlert, AuthField, AuthHeading, PasswordInput } from '@/components/auth/auth-form'

const loginSchema = z.object({
  email: z.string().min(1, 'Enter your email address').email('Enter a valid email address, like name@example.com'),
  password: z.string().min(1, 'Enter your password').min(6, 'Password must be at least 6 characters'),
})

type LoginFormData = z.infer<typeof loginSchema>

const emailShape = z.string().email()

/**
 * Where this address's single sign-on starts, or null. Asked once the typed
 * address has settled (so not on every keystroke); an address on a domain
 * whose organization has SSO switched on gets "Continue with single
 * sign-on" on the sign-in page.
 */
export function useSsoFor(email: string | undefined, delayMs = 400): string | null {
  const [loginUrl, setLoginUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    setLoginUrl(null)
    const address = (email ?? '').trim()
    if (!emailShape.safeParse(address).success) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const found = await authApi.discoverSso(address)
        if (!cancelled && found?.sso && found.loginUrl) setLoginUrl(found.loginUrl)
      } catch {
        // No answer: the password form is still there.
      }
    }, delayMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [email, delayMs])
  return loginUrl
}

const WRONG_PASSWORD = "That email and password don't match. Try again, or reset your password."

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { login, isLoading } = useAuthStore()
  const { success } = useNotifications()
  const [loginError, setLoginError] = React.useState<string | null>(null)
  // When login is refused with EMAIL_NOT_VERIFIED, we swap the form for a
  // "check your email" page with a resend action. Holds the address the
  // login attempt used so we can resend without re-asking.
  const [unverifiedEmail, setUnverifiedEmail] = React.useState<string | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<LoginFormData>({
    mode: 'onTouched',
    resolver: zodResolver(loginSchema),
  })
  const ssoLoginUrl = useSsoFor(watch('email'))

  // Honour ?returnTo=… so flows like the CLI browser login (which sends
  // the user through /auth/login?returnTo=/cli-login?…) and the MCP OAuth
  // authorize endpoint come back to where they started. Only those, so the
  // parameter is never an open redirect (see loginReturnTo).
  const returnTo = loginReturnTo(
    new URLSearchParams(location.search).get('returnTo'),
    import.meta.env.ALMYTY_API_BASE_URL || '',
  )

  const onSubmit = async (data: LoginFormData) => {
    setLoginError(null)
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
      // A wrong email or password answers 401 "Invalid credentials". Say
      // it in plain words, once, next to the button: the same sentence in
      // a toast as well only repeated it in a corner.
      setLoginError(
        err.response?.status === 401
          ? WRONG_PASSWORD
          : envelope?.error?.message || envelope?.message || WRONG_PASSWORD,
      )
    }
  }

  if (unverifiedEmail) {
    return (
      <CheckEmail
        email={unverifiedEmail}
        heading="Confirm your email first"
        lead="Your account is set up, but its email address isn't confirmed yet."
        onBack={() => setUnverifiedEmail(null)}
      />
    )
  }

  return (
    <div>
      <AuthHeading title="Sign in" lead="Welcome back. Sign in to your organization." />
      <Form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div>
          <AuthField id="email" label="Email address" error={errors.email?.message}>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="name@example.com"
              {...register('email')}
            />
          </AuthField>
          {ssoLoginUrl && (
            <div className="mt-3 space-y-2" data-testid="sso-sign-in">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  window.location.href = ssoLoginUrl
                }}
              >
                <KeyRound className="mr-2 h-4 w-4" aria-hidden />
                Continue with single sign-on
              </Button>
              <p className="text-xs text-muted-foreground">
                Your organization signs you in through its identity provider. Or use your password below.
              </p>
            </div>
          )}
        </div>

        <AuthField id="password" label="Password" error={errors.password?.message}>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            placeholder="Enter your password"
            {...register('password')}
          />
        </AuthField>

        <div className="flex items-center justify-between gap-4">
          <label htmlFor="remember-me" className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              id="remember-me"
              name="remember-me"
              type="checkbox"
              className="h-4 w-4 rounded border-input accent-primary"
            />
            Remember me
          </label>
          <Link
            to="/auth/forgot-password"
            className="text-sm font-semibold text-primary hover:text-primary-hover"
          >
            Forgot password?
          </Link>
        </div>

        {loginError && <AuthAlert>{loginError}</AuthAlert>}
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
      </Form>

      <p className="mt-8 border-t pt-6 text-sm text-muted-foreground">
        New to almyty?{' '}
        <Link
          to="/auth/register"
          className="font-semibold text-primary hover:text-primary-hover"
        >
          Sign up
        </Link>
      </p>
    </div>
  )
}