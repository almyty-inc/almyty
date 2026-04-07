import React from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/store/auth'
import { useNotifications } from '@/store/app'

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

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  })

  // Honour ?returnTo=… so flows like the CLI browser login (which sends
  // the user through /auth/login?returnTo=/cli-login?…) come back to
  // their original destination after a successful sign-in. Only allow
  // SAME-ORIGIN paths to prevent open-redirect.
  const returnTo = (() => {
    const raw = new URLSearchParams(location.search).get('returnTo')
    if (!raw) return null
    // Must be a relative path starting with `/` and NOT `//` (which is a
    // protocol-relative URL that would point off-origin).
    if (!raw.startsWith('/') || raw.startsWith('//')) return null
    return raw
  })()

  const onSubmit = async (data: LoginFormData) => {
    setLoginError(null)
    try {
      await login(data.email, data.password)
      success('Login successful', 'Welcome back!')
      navigate(returnTo ?? '/dashboard')
    } catch (err: any) {
      const errorMessage = err.response?.data?.message || 'Invalid credentials. Please check your email and password.'
      setLoginError(errorMessage)
      error('Login failed', errorMessage)
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-heading font-bold mb-6">Sign in</h1>
      {loginError && (
        <div className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-md">
          <p className="text-sm text-destructive">{loginError}</p>
        </div>
      )}
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

        <div>
          <Button
            type="submit"
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? 'Signing in...' : 'Sign in'}
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