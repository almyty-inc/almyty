import React from 'react'
import { Form } from '@/components/ui/form'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, MailCheck } from 'lucide-react'

import { authApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AuthAlert, AuthField, AuthHeading } from '@/components/auth/auth-form'
import { getApiErrorMessage } from '@/lib/api-error'

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
        getApiErrorMessage(
          err,
          'Something went wrong sending your reset link. Please try again.',
        ),
      )
    }
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-start gap-3">
          <MailCheck className="h-10 w-10 text-success" aria-hidden />
          <h1 className="font-heading text-[28px] font-bold leading-9 tracking-[-0.03em]">Check your email</h1>
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
      <AuthHeading title="Forgot your password?" lead="Enter your email and we'll send you a link to reset it." />
      <Form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <AuthField id="email" label="Email address" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" placeholder="name@example.com" {...register('email')} />
        </AuthField>

        <div className="space-y-4">
          {submitError && <AuthAlert>{submitError}</AuthAlert>}
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
      </Form>

      <p className="mt-8 border-t pt-6 text-sm text-muted-foreground">
        Remembered it?{' '}
        <Link to="/auth/login" className="font-semibold text-primary hover:text-primary-hover">
          Back to sign in
        </Link>
      </p>
    </div>
  )
}
