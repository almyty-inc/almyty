import React from 'react'
import { Form } from '@/components/ui/form'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/store/auth'
import { referralsApi } from '@/lib/api'
import { CaptchaWidget, isCaptchaEnabled } from '@/components/auth/captcha-widget'
import { CheckEmail } from '@/components/auth/check-email'
import { AuthAlert, AuthField, AuthHeading, PasswordInput } from '@/components/auth/auth-form'
import { getApiErrorMessage } from '@/lib/api-error'
import { readSignupAttribution } from '@/lib/signup-attribution'

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
  // Where the sign-up came from (utm_* / cta on the marketing site's link).
  // Read from this page's URL and sent with the form, never stored.
  const attribution = React.useMemo(() => readSignupAttribution(searchParams), [searchParams])
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
      const { email, verificationRequired } = await registerUser(data.email, data.password, data.firstName, data.lastName, data.organizationName, captchaToken || undefined, attribution)
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
      <AuthHeading title="Sign up" lead="Create your account and your organization's workspace." />
      <Form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2 sm:gap-4">
          <AuthField id="firstName" label="First name" error={errors.firstName?.message}>
            <Input id="firstName" type="text" autoComplete="given-name" {...register('firstName')} />
          </AuthField>
          <AuthField id="lastName" label="Last name" error={errors.lastName?.message}>
            <Input id="lastName" type="text" autoComplete="family-name" {...register('lastName')} />
          </AuthField>
        </div>

        <AuthField id="email" label="Email address" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" placeholder="name@example.com" {...register('email')} />
        </AuthField>

        <AuthField
          id="organizationName"
          label="Organization name"
          hint={<>Your team&apos;s workspace in almyty. You can rename it later.</>}
          error={errors.organizationName?.message}
        >
          <Input
            id="organizationName"
            type="text"
            autoComplete="organization"
            placeholder="Your company, team or your own name"
            {...register('organizationName')}
          />
        </AuthField>

        {/* The rules up front, not only after a password breaks them. */}
        <AuthField id="password" label="Password" hint={PASSWORD_RULES} error={errors.password?.message}>
          <PasswordInput id="password" autoComplete="new-password" {...register('password')} />
        </AuthField>

        <AuthField id="confirmPassword" label="Confirm password" error={errors.confirmPassword?.message}>
          <PasswordInput id="confirmPassword" autoComplete="new-password" {...register('confirmPassword')} />
        </AuthField>

        <div className="space-y-1.5">
          <div className="flex items-start gap-2">
            <input
              id="terms"
              type="checkbox"
              aria-invalid={errors.terms ? true : undefined}
              aria-describedby={errors.terms ? 'terms-error' : undefined}
              {...register('terms')}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-primary"
            />
            <Label htmlFor="terms" className="text-sm font-normal leading-5 text-foreground">
              {/* New tab, so following a link never loses what was typed here. */}
              I agree to the{' '}
              <a
                href={TERMS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-primary underline-offset-2 hover:text-primary-hover hover:underline"
              >
                Terms of Service
              </a>{' '}
              and{' '}
              <a
                href={PRIVACY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-primary underline-offset-2 hover:text-primary-hover hover:underline"
              >
                Privacy Policy
              </a>
            </Label>
          </div>
          {errors.terms && (
            <p id="terms-error" className="text-sm text-destructive">{errors.terms.message}</p>
          )}
        </div>

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

        {registerError && <AuthAlert>{registerError}</AuthAlert>}
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
      </Form>

      {/* No OAuth providers are wired up yet, so no "Or continue with". */}
      <p className="mt-8 border-t pt-6 text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          to="/auth/login"
          className="font-semibold text-primary hover:text-primary-hover"
        >
          Sign in
        </Link>
      </p>
    </div>
  )
}