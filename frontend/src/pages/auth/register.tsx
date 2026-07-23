import React from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/store/auth'
import { useNotifications } from '@/store/app'
import { apiPost, referralsApi } from '@/lib/api'
import { CaptchaWidget, isCaptchaEnabled } from '@/components/auth/captcha-widget'

const registerSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  email: z.string().email('Invalid email address'),
  organizationName: z.string()
    .min(2, 'Organization name must be at least 2 characters')
    .max(100, 'Organization name must be less than 100 characters'),
  password: z.string().min(8, 'Password must be at least 8 characters')
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, 'Password must contain at least one lowercase letter, one uppercase letter, and one number'),
  confirmPassword: z.string(),
  terms: z.boolean().refine(val => val === true, {
    message: 'You must accept the terms and conditions',
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

  // Referral attribution for ?ref= links: ask the backend to set the
  // attribution cookie on the API origin so registration picks it up
  // server-side. Best-effort — a failure must never affect signup.
  React.useEffect(() => {
    if (referralCode) {
      referralsApi.attribute(referralCode).catch(() => {})
    }
  }, [referralCode])
  const { register: registerUser, isLoading } = useAuthStore()
  const { success, error } = useNotifications()
  const [showPassword, setShowPassword] = React.useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false)
  const [captchaToken, setCaptchaToken] = React.useState('')
  const [registerError, setRegisterError] = React.useState<string | null>(null)
  const captchaEnabled = isCaptchaEnabled()

  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<RegisterFormData>({
    // Validate on every touch so the submit button can reflect
    // isValid as soon as the user has engaged with each field.
    mode: 'onTouched',
    resolver: zodResolver(registerSchema),
  })

  const onSubmit = async (data: RegisterFormData) => {
    setRegisterError(null)
    if (captchaEnabled && !captchaToken) {
      error('Verification required', 'Please complete the verification challenge.')
      return
    }
    try {
      await registerUser(data.email, data.password, data.firstName, data.lastName, data.organizationName, captchaToken || undefined)
      if (inviteToken) {
        try {
          await apiPost(`/invites/${inviteToken}/accept`, {})
          success('Account created', 'Welcome to almyty! Invitation accepted.')
        } catch {
          success('Account created', 'Welcome! You can accept the invitation from your dashboard.')
        }
      } else {
        success('Account created successfully', 'Welcome to almyty!')
      }
      navigate('/dashboard')
    } catch (err: any) {
      const message =
        err.response?.data?.message || 'Please check your information and try again.'
      setRegisterError(message)
      error('Registration failed', message)
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-heading font-bold mb-6">Sign up</h1>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div>
          <Label htmlFor="firstName">First Name</Label>
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
              <p className="mt-2 text-sm text-red-600">{errors.firstName.message}</p>
            )}
          </div>
        </div>

        <div>
          <Label htmlFor="lastName">Last Name</Label>
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
              <p className="mt-2 text-sm text-red-600">{errors.lastName.message}</p>
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
              <p className="mt-2 text-sm text-red-600">{errors.email.message}</p>
            )}
          </div>
        </div>

        <div>
          <Label htmlFor="organizationName">Organization Name</Label>
          <div className="mt-1">
            <Input
              id="organizationName"
              type="text"
              placeholder="Enter your organization name"
              {...register('organizationName')}
              className={errors.organizationName ? 'border-red-300' : ''}
            />
            {errors.organizationName && (
              <p className="mt-2 text-sm text-red-600">{errors.organizationName.message}</p>
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

        <div>
          <Label htmlFor="confirmPassword">Confirm Password</Label>
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
              <p className="mt-2 text-sm text-red-600">{errors.confirmPassword.message}</p>
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
            I agree to the{' '}
            <a href="#" className="text-primary hover:text-primary/80">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="#" className="text-primary hover:text-primary/80">
              Privacy Policy
            </a>
          </Label>
        </div>
        {errors.terms && (
          <p className="text-sm text-red-600">{errors.terms.message}</p>
        )}

        {captchaEnabled && (
          <div>
            <CaptchaWidget onToken={setCaptchaToken} />
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
      </form>

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