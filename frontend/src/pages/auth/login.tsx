import React from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/store/auth'
import { useNotifications } from '@/store/app'
import { authApi } from '@/lib/api'
import { loginReturnTo } from '@/lib/return-to'
import { CheckEmail } from '@/components/auth/check-email'

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
  const [showPassword, setShowPassword] = React.useState(false)
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
              <p className="mt-2 text-sm text-destructive">{errors.email.message}</p>
            )}
          </div>
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
              <p className="mt-2 text-sm text-destructive">{errors.password.message}</p>
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