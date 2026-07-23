import React from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, MailCheck } from 'lucide-react'

import { authApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const forgotSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Invalid email address'),
})

type ForgotFormData = z.infer<typeof forgotSchema>

/**
 * Request-a-password-reset page (`/auth/forgot-password`).
 *
 * The backend is deliberately email-enumeration-safe: it returns 200 whether
 * or not the address maps to an account. The UI mirrors that — on success we
 * always show the same neutral "if an account exists…" message and never
 * reveal whether the email was found.
 */
export function ForgotPasswordPage() {
  const [sent, setSent] = React.useState(false)
  const [submitError, setSubmitError] = React.useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotFormData>({
    mode: 'onTouched',
    resolver: zodResolver(forgotSchema),
  })

  const onSubmit = async (data: ForgotFormData) => {
    setSubmitError(null)
    try {
      await authApi.forgotPassword(data.email)
      setSent(true)
    } catch (err: any) {
      setSubmitError(
        err?.response?.data?.message ||
          'Something went wrong sending your reset link. Please try again.',
      )
    }
  }

  if (sent) {
    return (
      <div className="text-center space-y-4">
        <div className="flex flex-col items-center gap-3 py-4">
          <MailCheck className="h-10 w-10 text-emerald-500" aria-hidden />
          <h1 className="text-2xl font-heading font-bold">Check your email</h1>
          <p className="text-sm text-muted-foreground">
            If an account exists for that address, we've sent a link to reset
            your password. The link expires in one hour.
          </p>
          <Button asChild variant="outline" className="mt-2">
            <Link to="/auth/login">Back to sign in</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-heading font-bold mb-2">Forgot your password?</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Enter your email and we'll send you a link to reset it.
      </p>
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
          {submitError && (
            <div
              role="alert"
              aria-live="polite"
              className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-md"
            >
              <p className="text-sm text-destructive">{submitError}</p>
            </div>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting}
            aria-disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                Sending...
              </>
            ) : (
              'Send reset link'
            )}
          </Button>
        </div>
      </form>

      <div className="mt-6 text-center">
        <p className="text-sm text-muted-foreground">
          Remembered it?{' '}
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
