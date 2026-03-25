import React, { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { useAuthStore } from '@/store/auth'
import { apiGet, apiPost } from '@/lib/api'
import { CheckCircle, XCircle, LogIn } from 'lucide-react'

interface InviteDetails {
  organizationName: string
  role: string
  email: string
  isExpired: boolean
}

export function AcceptInvitePage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token')
  const { user } = useAuthStore()

  const [details, setDetails] = useState<InviteDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    if (!token) {
      setError('No invitation token provided')
      setLoading(false)
      return
    }

    apiGet<InviteDetails>(`/invites/${token}`)
      .then((data) => setDetails(data))
      .catch((err) => setError(err?.response?.data?.message || 'Invalid invitation'))
      .finally(() => setLoading(false))
  }, [token])

  const handleAccept = async () => {
    if (!token) return

    if (!user) {
      // Not logged in — redirect to login with return URL
      navigate(`/auth/login?returnTo=${encodeURIComponent(`/invite/accept?token=${token}`)}`)
      return
    }

    setAccepting(true)
    try {
      await apiPost(`/invites/${token}/accept`, {})
      setAccepted(true)
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to accept invitation')
    } finally {
      setAccepting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-lg space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold font-heading">almyty</h1>
        </div>

        {error && !details && (
          <div className="text-center space-y-4">
            <XCircle className="h-12 w-12 text-destructive mx-auto" />
            <p className="text-lg font-medium">{error}</p>
            <Button onClick={() => navigate('/auth/login')}>Go to Login</Button>
          </div>
        )}

        {details && details.isExpired && (
          <div className="text-center space-y-4">
            <XCircle className="h-12 w-12 text-destructive mx-auto" />
            <p className="text-lg font-medium">Invitation Expired</p>
            <p className="text-sm text-muted-foreground">
              This invitation to {details.organizationName} has expired. Ask the admin to send a new one.
            </p>
            <Button onClick={() => navigate('/auth/login')}>Go to Login</Button>
          </div>
        )}

        {details && !details.isExpired && !accepted && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <p className="text-lg">You've been invited to join</p>
              <p className="text-2xl font-bold">{details.organizationName}</p>
              <p className="text-sm text-muted-foreground">as <span className="font-medium capitalize">{details.role}</span></p>
            </div>

            {!user && (
              <p className="text-sm text-muted-foreground text-center">
                You need to log in or create an account to accept this invitation.
              </p>
            )}

            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}

            <Button className="w-full" size="lg" onClick={handleAccept} disabled={accepting}>
              {accepting ? (
                <LoadingSpinner size="sm" className="mr-2" />
              ) : user ? (
                <CheckCircle className="h-4 w-4 mr-2" />
              ) : (
                <LogIn className="h-4 w-4 mr-2" />
              )}
              {user ? 'Accept Invitation' : 'Log in to Accept'}
            </Button>
          </div>
        )}

        {accepted && (
          <div className="text-center space-y-4">
            <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
            <p className="text-lg font-medium">Welcome to {details?.organizationName}!</p>
            <p className="text-sm text-muted-foreground">You've joined as {details?.role}.</p>
            <Button onClick={() => navigate('/dashboard')}>Go to Dashboard</Button>
          </div>
        )}
      </div>
    </div>
  )
}
