import React from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { CheckCircle2, Eye, EyeOff, XCircle } from 'lucide-react'

import { authApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const resetSchema = z
  .object({
    password: z
      .string()
      .min(1, 'Password is required')
      .min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

type ResetFormData = z.infer<typeof resetSchema>

/**
 * Landing page for the emailed password-reset link
 * (`/auth/reset-password?token=`). The backend sends this exact path
 * (mail.service.ts builds `${FRONTEND_URL}/auth/reset-password?token=`),
 * so the page reads the token from the query, collects a new password, and
 * calls the backend. Lives in the public `/auth/*` group — a missing route
 * here would fall through to the login redirect (the verify-email bug).
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const [done, setDone] = React.useState(false)
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [showPassword, setShowPassword] = React.useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetFormData>({
    mode: 'onTouched',
    resolver: zodResolver(resetSchema),
  })

  const onSubmit = async (data: ResetFormData) => {
    setSubmitError(null)
    try {
      await authApi.resetPassword(token, data.password)
      setDone(true)
    } catch (err: any) {
      setSubmitError(
        err?.response?.data?.message ||
          'This reset link is invalid or has expired. Request a new one below.',
      )
    }
  }

  // Missing token → the link is malformed; there is nothing to submit.
  if (!token) {
    return (
      <div className="text-center space-y-4">
        <div className="flex flex-col items-center gap-3 py-4">
          <XCircle className="h-10 w-10 text-red-500" aria-hidden />
          <h1 className="text-2xl font-heading font-bold">Invalid reset link</h1>
          <p className="text-sm text-muted-foreground">
            This password reset link is missing its token. Request a new one to
            continue.
          </p>
          <Button asChild variant="outline" className="mt-2">
            <Link to="/auth/forgot-password">Request a new link</Link>
          </Button>
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div className="text-center space-y-4">
        <div className="flex flex-col items-center gap-3 py-4">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" aria-hidden />
          <h1 className="text-2xl font-heading font-bold">Password reset</h1>
          <p className="text-sm text-muted-foreground">
            Your password has been updated. You can now sign in with your new
            password.
          </p>
          <Button asChild className="mt-2">
            <Link to="/auth/login">Go to sign in</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-heading font-bold mb-2">Reset your password</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Choose a new password for your account.
      </p>
      {submitError && (
        <div className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-md">
          <p className="text-sm text-destructive">{submitError}</p>
          <Link
            to="/auth/forgot-password"
            className="mt-1 inline-block text-sm font-medium text-primary hover:text-primary/80"
          >
            Request a new link
          </Link>
        </div>
      )}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div>
          <Label htmlFor="password">New password</Label>
          <div className="mt-1 relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="Enter a new password"
              {...register('password')}
              className={errors.password ? 'border-red-300' : ''}
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 pr-3 flex items-center"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
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
          <Label htmlFor="confirmPassword">Confirm new password</Label>
          <div className="mt-1">
            <Input
              id="confirmPassword"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder="Re-enter your new password"
              {...register('confirmPassword')}
              className={errors.confirmPassword ? 'border-red-300' : ''}
            />
            {errors.confirmPassword && (
              <p className="mt-2 text-sm text-red-600">
                {errors.confirmPassword.message}
              </p>
            )}
          </div>
        </div>

        <div>
          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting}
            aria-disabled={isSubmitting}
          >
            {isSubmitting ? 'Resetting...' : 'Reset password'}
          </Button>
        </div>
      </form>

      <div className="mt-6 text-center">
        <p className="text-sm text-muted-foreground">
          <Link
            to="/auth/login"
            className="font-medium text-primary hover:text-primary/80"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
