import React from 'react'
import { Form } from '@/components/ui/form'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/store/auth'
import { referralsApi } from '@/lib/api'
import { CaptchaWidget, isCaptchaEnabled } from '@/components/auth/captcha-widget'
import { CheckEmail } from '@/components/auth/check-email'
import { getApiErrorMessage } from '@/lib/api-error'

/** The documents the consent checkbox names, on the website. */
export const TERMS_URL = 'https://almyty.com/terms'
export const PRIVACY_URL = 'https://almyty.com/privacy'

export const PASSWORD_RULES = 'At least 8 characters, with an uppercase letter, a lowercase letter and a number.'

const registerSchema = z.object({
  firstName: z.string().min(1, 'Enter your first name'),
  lastName: z.string().min(1, 'Enter your last name'),
  email: z.string().min(1, 'Enter your email address').email('Enter a valid email address, like name@example.com'),
  organizationName: z.string()
    .min(2, 'Organization name must be at least 2 characters')
    .max(100, 'Organization name must be less than 100 characters'),
  password: z.string().min(8, 'Use at least 8 characters')
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, 'Add an uppercase letter, a lowercase letter and a number'),
  confirmPassword: z.string(),
  terms: z.boolean().refine(val => val === true, {
    message: 'Accept the Terms of Service and Privacy Policy to continue',
  }),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ['confirmPassword'],
})

type RegisterFormData = z.infer<typeof registerSchema>

export function RegisterPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const inviteToken = searchParams.get('invite')
  const referralCode = searchParams.get('ref')
  // Where to sign in once the address is confirmed; an invite comes back.
  const signInTo = inviteToken
    ? `/auth/login?returnTo=${encodeURIComponent(`/invite/accept?token=${encodeURIComponent(inviteToken)}`)}`
    : '/auth/login'

  // Referral attribution for ?ref= links: ask the backend to set the
  // attribution cookie on the API origin so registration picks it up
  // server-side. Best-effort — a failure must never affect signup.
  React.useEffect(() => {
    if (referralCode) {
      referralsApi.attribute(referralCode).catch(() => {})
    }
  }, [referralCode])
  const { register: registerUser, isLoading } = useAuthStore()
  const [showPassword, setShowPassword] = React.useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false)
  const [captchaToken, setCaptchaToken] = React.useState('')
  const [captchaError, setCaptchaError] = React.useState(false)
  const [registerError, setRegisterError] = React.useState<string | null>(null)
  // Set once the account exists: the form gives way to "check your email".
  const [registeredEmail, setRegisteredEmail] = React.useState<string | null>(null)
  const captchaEnabled = isCaptchaEnabled()

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterFormData>({
    // Validate on every touch so the submit button can reflect
    // isValid as soon as the user has engaged with each field.
    mode: 'onTouched',
    resolver: zodResolver(registerSchema),
  })

  const onCaptchaToken = React.useCallback((token: string) => {
    setCaptchaToken(token)
    if (token) setCaptchaError(false)
  }, [])

  const onSubmit = async (data: RegisterFormData) => {
    setRegisterError(null)
    if (captchaEnabled && !captchaToken) {
      // Said under the check itself, in its own words, not in a toast in
      // the far corner of the screen.
      setCaptchaError(true)
      return
    }
    try {
      const { email, verificationRequired } = await registerUser(data.email, data.password, data.firstName, data.lastName, data.organizationName, captchaToken || undefined)
      // No session yet: signing in needs the confirmed address. An invite
      // is accepted after that sign-in (returnTo below). An address the
      // server confirmed at once (a test stack's AUTO_VERIFY_EMAIL_DOMAIN)
      // goes straight to sign-in.
      if (!verificationRequired) {
        navigate(signInTo)
        return
      }
      setRegisteredEmail(email)
    } catch (err: any) {
      setRegisterError(getApiErrorMessage(err, 'Please check your information and try again.'))
    }
  }

  if (registeredEmail) {
    return (
      <CheckEmail
        email={registeredEmail}
        lead={
          inviteToken
            ? 'Your account is created. Confirm your email, then sign in to join the team that invited you.'
            : 'Your account is created.'
        }
        signInTo={signInTo}
      />
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-heading font-bold mb-6">Sign up</h1>
      <Form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div>
          <Label htmlFor="firstName">First name</Label>
          <div className="mt-1">
            <Input
              id="firstName"
              type="text"
              autoComplete="given-name"
              placeholder="Enter your first name"
              {...register('firstName')}
              className={errors.firstName ? 'border-red-300' : ''}
            />
            {errors.firstName && (
              <p className="mt-2 text-sm text-destructive">{errors.firstName.message}</p>
            )}
          </div>
        </div>

        <div>
          <Label htmlFor="lastName">Last name</Label>
          <div className="mt-1">
            <Input
              id="lastName"
              type="text"
              autoComplete="family-name"
              placeholder="Enter your last name"
              {...register('lastName')}
              className={errors.lastName ? 'border-red-300' : ''}
            />
            {errors.lastName && (
              <p className="mt-2 text-sm text-destructive">{errors.lastName.message}</p>
            )}
          </div>
        </div>

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
        </div>

        <div>
          <Label htmlFor="organizationName">Organization name</Label>
          <div className="mt-1">
            <Input
              id="organizationName"
              type="text"
              autoComplete="organization"
              placeholder="Your company, team or your own name"
              aria-describedby="organization-help"
              {...register('organizationName')}
              className={errors.organizationName ? 'border-red-300' : ''}
            />
            <p id="organization-help" className="mt-2 text-xs text-muted-foreground">
              Your team&apos;s workspace in almyty. You can rename it later.
            </p>
            {errors.organizationName && (
              <p className="mt-1 text-sm text-destructive">{errors.organizationName.message}</p>
            )}
          </div>
        </div>

        <div>
          <Label htmlFor="password">Password</Label>
          <div className="mt-1 relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="Create a password"
              aria-describedby="password-rules"
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
          </div>
          {/* The rules up front, not only after a password breaks them. */}
          <p id="password-rules" className="mt-2 text-xs text-muted-foreground">{PASSWORD_RULES}</p>
          {errors.password && (
            <p className="mt-1 text-sm text-destructive">{errors.password.message}</p>
          )}
        </div>

        <div>
          <Label htmlFor="confirmPassword">Confirm password</Label>
          <div className="mt-1 relative">
            <Input
              id="confirmPassword"
              type={showConfirmPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="Confirm your password"
              {...register('confirmPassword')}
              className={errors.confirmPassword ? 'border-red-300' : ''}
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 pr-3 flex items-center"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
            >
              {showConfirmPassword ? (
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Eye className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {errors.confirmPassword && (
              <p className="mt-2 text-sm text-destructive">{errors.confirmPassword.message}</p>
            )}
          </div>
        </div>

        <div className="flex items-center">
          <input
            id="terms"
            type="checkbox"
            {...register('terms')}
            className="h-4 w-4 text-primary focus:ring-primary border-border rounded"
          />
          <Label htmlFor="terms" className="ml-2 block text-sm text-foreground">
            {/* New tab, so following a link never loses what was typed here. */}
            I agree to the{' '}
            <a
              href={TERMS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary hover:text-primary/80 underline-offset-2 hover:underline"
            >
              Terms of Service
            </a>{' '}
            and{' '}
            <a
              href={PRIVACY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary hover:text-primary/80 underline-offset-2 hover:underline"
            >
              Privacy Policy
            </a>
          </Label>
        </div>
        {errors.terms && (
          <p className="text-sm text-destructive">{errors.terms.message}</p>
        )}

        {captchaEnabled && (
          <div>
            <CaptchaWidget onToken={onCaptchaToken} />
            {captchaError && (
              <p className="mt-2 text-sm text-destructive" role="alert">
                Tick &ldquo;Verify you are human&rdquo; above to continue.
              </p>
            )}
          </div>
        )}

        <div>
          {registerError && (
            <div
              role="alert"
              aria-live="polite"
              className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-md"
            >
              <p className="text-sm text-destructive">{registerError}</p>
            </div>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={isLoading}
            aria-disabled={isLoading}
            title={isLoading ? 'Creating your account…' : undefined}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                Creating account...
              </>
            ) : (
              'Create account'
            )}
          </Button>
        </div>
      </Form>

      <div className="mt-6">
        {/* No OAuth providers are wired up yet — a bare divider here
            used to read "Or continue with" followed by nothing. */}
        <div className="border-t border-border" />

        <div className="mt-6 text-center">
          <p className="text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link
              to="/auth/login"
              className="font-medium text-primary hover:text-primary/80"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}